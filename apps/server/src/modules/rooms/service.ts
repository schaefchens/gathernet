import { randomBytes } from 'node:crypto'
import type {
  AppUserId,
  CreateRoomRequest,
  GroupId,
  JoinRoomRequest,
  JoinRoomResponse,
  RoomBrowserItem,
  RoomCode,
  RoomDetailResponse,
  RoomJoinRequestSummary,
  ServerMessage,
} from '@gathernet/shared'
import {
  ROOM_CLOSED_RETENTION_DAYS,
  ROOM_INACTIVE_EXPIRE_DAYS,
  ROOM_JOIN_REQUEST_TTL_MS,
} from '@gathernet/shared'
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  accounts,
  appDevices,
  groupMembers,
  groups,
  mlsCursors,
  mlsMessages,
  roomJoinRequests,
  roomMembers,
  rooms,
  welcomes,
} from '../../db/schema.ts'
import { newRoomCode } from '../../lib/codes.ts'
import { sha256 } from '../../lib/crypto.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'

/**
 * E2EE rooms (M2 stage 4). A room is a groups row of kind 'room' plus a rooms
 * row keyed by the same id. Account-level membership lives in room_members;
 * MLS leaves (real devices AND app_devices) live in group_members. The server
 * never sees room plaintext — it authorizes membership and sequences commits
 * (see modules/delivery/service.ts for the kind='room' commit rules).
 */

/** The slice of AppSessionIdentity the rooms service needs. */
export interface RoomCaller {
  appId: string
  accountId: string
  appUserId: string
  displayName: string
}

const CODE_RETRIES = 5

/* ------------------------------- app devices ------------------------------ */

/**
 * Register an SDK-generated room device for this (app, account). Idempotent
 * by devicePk. The device id follows the real-device rule:
 * hex(first 16 bytes of SHA-256(devicePk)).
 */
export async function registerAppDevice(
  db: Db,
  caller: RoomCaller,
  devicePkB64: string,
  name: string,
): Promise<{ deviceId: string }> {
  const devicePk = Buffer.from(devicePkB64, 'base64')
  if (devicePk.length !== 32) throw new ServiceError(400, 'invalid_device_pk')
  const deviceId = sha256(devicePk).subarray(0, 16).toString('hex')

  const existing = await db.query.appDevices.findFirst({
    where: eq(appDevices.deviceId, deviceId),
  })
  if (existing) {
    if (existing.pubId !== caller.appId || existing.accountId !== caller.accountId) {
      // Someone else registered this exact public key — adversarial reuse.
      throw new ServiceError(409, 'device_pk_taken')
    }
    return { deviceId }
  }

  await db
    .insert(appDevices)
    .values({
      deviceId,
      pubId: caller.appId,
      accountId: caller.accountId,
      appUserId: caller.appUserId,
      devicePk,
      name,
    })
    .onConflictDoNothing()
  return { deviceId }
}

/**
 * Resolve the app device a WS app session binds to: the explicitly named one,
 * or the newest registered device of this (app, account). Null → the SDK must
 * register a device before connecting.
 */
export async function resolveAppDevice(
  db: Db,
  appId: string,
  accountId: string,
  deviceId?: string,
): Promise<{ deviceId: string } | null> {
  if (deviceId) {
    const row = await db.query.appDevices.findFirst({
      where: and(
        eq(appDevices.deviceId, deviceId),
        eq(appDevices.pubId, appId),
        eq(appDevices.accountId, accountId),
      ),
    })
    return row ? { deviceId: row.deviceId } : null
  }
  const rows = await db
    .select({ deviceId: appDevices.deviceId })
    .from(appDevices)
    .where(and(eq(appDevices.pubId, appId), eq(appDevices.accountId, accountId)))
    .orderBy(desc(appDevices.createdAt))
    .limit(1)
  return rows[0] ?? null
}

export async function requireOwnAppDevice(
  db: Db,
  caller: RoomCaller,
  deviceId: string,
): Promise<void> {
  const device = await resolveAppDevice(db, caller.appId, caller.accountId, deviceId)
  if (!device) throw new ServiceError(400, 'unknown_device')
}

/* -------------------------------- lifecycle ------------------------------- */

export async function createRoom(
  db: Db,
  caller: RoomCaller,
  input: CreateRoomRequest,
): Promise<{ roomId: string; code: string }> {
  const roomId = randomBytes(16).toString('hex')
  const code = await db.transaction(async (tx) => {
    await tx.insert(groups).values({
      groupId: roomId,
      kind: 'room',
      accountA: null,
      accountB: null,
      creatorAccountId: caller.accountId,
    })

    // Codes are only unique among LIVE rooms of the same app; retry on clash.
    let picked: string | null = null
    for (let i = 0; i < CODE_RETRIES; i++) {
      const candidate = newRoomCode()
      const clash = await tx
        .select({ roomId: rooms.roomId })
        .from(rooms)
        .where(
          and(eq(rooms.pubId, caller.appId), eq(rooms.code, candidate), ne(rooms.phase, 'closed')),
        )
        .limit(1)
      if (clash.length === 0) {
        picked = candidate
        break
      }
    }
    if (!picked) throw new ServiceError(503, 'room_codes_exhausted')

    await tx.insert(rooms).values({
      roomId,
      pubId: caller.appId,
      code: picked,
      visibility: input.visibility,
      title: input.title,
      hostAccountId: caller.accountId,
      maxMembers: input.maxMembers,
      compatTag: input.compatTag,
    })
    await tx.insert(roomMembers).values({
      roomId,
      accountId: caller.accountId,
      appUserId: caller.appUserId,
    })
    return picked
  })
  return { roomId, code }
}

/**
 * Epoch-0 GroupInfo publish: the host created the MLS group locally and
 * uploads its GroupInfo so everyone else can external-join at epoch 0
 * (mls-rs epoch-0 external joins are verified working). Also inserts the
 * host's app device as the first MLS leaf.
 */
export async function publishGroupInfo(
  db: Db,
  caller: RoomCaller,
  roomId: string,
  groupInfoB64: string,
  deviceId: string,
): Promise<void> {
  const { room, group } = await loadRoom(db, caller.appId, roomId)
  if (room.hostAccountId !== caller.accountId) throw new ServiceError(403, 'not_host')
  await requireOwnAppDevice(db, caller, deviceId)
  if (group.currentEpoch !== 0) throw new ServiceError(409, 'not_epoch_zero')

  const leaves = await db
    .select({ deviceId: groupMembers.deviceId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, roomId))
    .limit(1)
  if (leaves.length > 0) throw new ServiceError(409, 'already_initialized')

  await db.transaction(async (tx) => {
    await tx
      .update(groups)
      .set({ groupInfo: Buffer.from(groupInfoB64, 'base64'), groupInfoEpoch: 0 })
      .where(eq(groups.groupId, roomId))
    await tx.insert(groupMembers).values({
      groupId: roomId,
      deviceId,
      accountId: caller.accountId,
      addedEpoch: 0,
    })
    await touchRoom(tx, roomId)
  })
}

export async function listPublicRooms(db: Db, appId: string): Promise<RoomBrowserItem[]> {
  const rows = await db
    .select({
      roomId: rooms.roomId,
      title: rooms.title,
      maxMembers: rooms.maxMembers,
      compatTag: rooms.compatTag,
      memberCount: sql<number>`(
        SELECT count(*)::int FROM room_members rm
        WHERE rm.room_id = ${rooms.roomId} AND rm.status = 'active'
      )`,
    })
    .from(rooms)
    .where(and(eq(rooms.pubId, appId), eq(rooms.visibility, 'public'), eq(rooms.phase, 'open')))
    .orderBy(asc(rooms.createdAt))
  return rows.map((r) => ({
    roomId: r.roomId as GroupId,
    title: r.title,
    memberCount: r.memberCount,
    maxMembers: r.maxMembers,
    compatTag: r.compatTag,
  }))
}

export async function joinRoom(
  db: Db,
  registry: ConnectionRegistry,
  caller: RoomCaller,
  input: JoinRoomRequest,
): Promise<JoinRoomResponse> {
  await requireOwnAppDevice(db, caller, input.deviceId)

  const room = input.roomId
    ? await db.query.rooms.findFirst({ where: eq(rooms.roomId, input.roomId) })
    : await db.query.rooms.findFirst({
        where: and(
          eq(rooms.pubId, caller.appId),
          eq(rooms.code, input.code ?? ''),
          ne(rooms.phase, 'closed'),
        ),
      })
  if (!room || room.pubId !== caller.appId || room.phase === 'closed') {
    throw new ServiceError(404, 'room_not_found')
  }
  if (room.compatTag !== input.compatTag) throw new ServiceError(426, 'compat_mismatch')

  const group = await db.query.groups.findFirst({ where: eq(groups.groupId, room.roomId) })
  if (!group) throw new ServiceError(404, 'room_not_found')

  const joined = (): JoinRoomResponse => ({
    status: 'joined',
    roomId: room.roomId as GroupId,
    code: room.code as RoomCode,
    groupInfo: group.groupInfo?.toString('base64') ?? null,
    epoch: group.groupInfoEpoch ?? group.currentEpoch,
  })

  const membership = await db.query.roomMembers.findFirst({
    where: and(eq(roomMembers.roomId, room.roomId), eq(roomMembers.accountId, caller.accountId)),
  })
  if (membership?.status === 'kicked') throw new ServiceError(403, 'kicked')
  if (membership?.status === 'active') return joined()

  const activeCount = await countActiveMembers(db, room.roomId)
  if (activeCount >= room.maxMembers) throw new ServiceError(409, 'room_full')

  if (room.phase === 'open') {
    await db.transaction(async (tx) => {
      await tx
        .insert(roomMembers)
        .values({ roomId: room.roomId, accountId: caller.accountId, appUserId: caller.appUserId })
        .onConflictDoUpdate({
          target: [roomMembers.roomId, roomMembers.accountId],
          set: { status: 'active', joinedAt: new Date(), leftAt: null },
        })
      await touchRoom(tx, room.roomId)
    })
    await emitToRoomDevices(db, registry, room.roomId, {
      type: 'room.member_joined',
      payload: {
        roomId: room.roomId as GroupId,
        appUserId: caller.appUserId as AppUserId,
        displayName: caller.displayName,
      },
    })
    return joined()
  }

  // in_progress → knock. One pending request per (room, account); re-joining
  // while one is pending returns the same request.
  const pendingSince = new Date(Date.now() - ROOM_JOIN_REQUEST_TTL_MS)
  const existing = await db.query.roomJoinRequests.findFirst({
    where: and(
      eq(roomJoinRequests.roomId, room.roomId),
      eq(roomJoinRequests.accountId, caller.accountId),
      eq(roomJoinRequests.status, 'pending'),
    ),
  })
  if (existing && existing.createdAt >= pendingSince) {
    return { status: 'pending', requestId: existing.id }
  }
  if (existing) {
    await db
      .update(roomJoinRequests)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(eq(roomJoinRequests.id, existing.id))
  }
  const [request] = await db
    .insert(roomJoinRequests)
    .values({ roomId: room.roomId, accountId: caller.accountId, appUserId: caller.appUserId })
    .returning({ id: roomJoinRequests.id })
  if (!request) throw new ServiceError(500, 'internal')
  registry.sendToAppAccount(caller.appId, room.hostAccountId, {
    type: 'room.join_request',
    payload: {
      roomId: room.roomId as GroupId,
      requestId: request.id,
      appUserId: caller.appUserId as AppUserId,
      displayName: caller.displayName,
    },
  })
  return { status: 'pending', requestId: request.id }
}

export async function getRoomDetail(
  db: Db,
  caller: RoomCaller,
  roomId: string,
): Promise<RoomDetailResponse> {
  const { room, group } = await loadRoom(db, caller.appId, roomId)
  const members = await db
    .select({
      accountId: roomMembers.accountId,
      appUserId: roomMembers.appUserId,
      isService: roomMembers.isService,
      displayName: accounts.displayName,
      deviceCount: sql<number>`(
        SELECT count(*)::int FROM group_members gm
        WHERE gm.group_id = ${roomId} AND gm.account_id = ${roomMembers.accountId}
          AND gm.removed_epoch IS NULL
      )`,
    })
    .from(roomMembers)
    .innerJoin(accounts, eq(accounts.accountId, roomMembers.accountId))
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, 'active')))
    .orderBy(asc(roomMembers.joinedAt))

  const self = members.find((m) => m.accountId === caller.accountId)
  if (!self) throw new ServiceError(403, 'not_a_member')
  const host = members.find((m) => m.accountId === room.hostAccountId)

  return {
    roomId: room.roomId as GroupId,
    code: room.code as RoomCode,
    title: room.title,
    phase: room.phase,
    visibility: room.visibility,
    hostAppUserId: (host?.appUserId ?? '') as AppUserId,
    groupInfo: group.groupInfo?.toString('base64') ?? null,
    epoch: group.groupInfoEpoch ?? group.currentEpoch,
    members: members.map((m) => ({
      appUserId: m.appUserId as AppUserId,
      displayName: m.displayName,
      isHost: m.accountId === room.hostAccountId,
      isService: m.isService,
      deviceCount: m.deviceCount,
    })),
  }
}

/* ------------------------------ join requests ----------------------------- */

export async function listJoinRequests(
  db: Db,
  caller: RoomCaller,
  roomId: string,
): Promise<RoomJoinRequestSummary[]> {
  const { room } = await loadRoom(db, caller.appId, roomId)
  if (room.hostAccountId !== caller.accountId) throw new ServiceError(403, 'not_host')
  const cutoff = new Date(Date.now() - ROOM_JOIN_REQUEST_TTL_MS)
  const rows = await db
    .select({
      id: roomJoinRequests.id,
      appUserId: roomJoinRequests.appUserId,
      accountId: roomJoinRequests.accountId,
      createdAt: roomJoinRequests.createdAt,
      displayName: accounts.displayName,
    })
    .from(roomJoinRequests)
    .innerJoin(accounts, eq(accounts.accountId, roomJoinRequests.accountId))
    .where(and(eq(roomJoinRequests.roomId, roomId), eq(roomJoinRequests.status, 'pending')))
    .orderBy(asc(roomJoinRequests.createdAt))
  return rows
    .filter((r) => r.createdAt >= cutoff)
    .map((r) => ({
      requestId: r.id,
      appUserId: r.appUserId as AppUserId,
      displayName: r.displayName,
      createdAt: r.createdAt.getTime(),
    }))
}

export async function resolveJoinRequest(
  db: Db,
  registry: ConnectionRegistry,
  caller: RoomCaller,
  roomId: string,
  requestId: string,
  action: 'approve' | 'decline',
): Promise<void> {
  const { room, group } = await loadRoom(db, caller.appId, roomId)
  if (room.hostAccountId !== caller.accountId) throw new ServiceError(403, 'not_host')
  const request = await db.query.roomJoinRequests.findFirst({
    where: and(eq(roomJoinRequests.id, requestId), eq(roomJoinRequests.roomId, roomId)),
  })
  if (!request || request.status !== 'pending') throw new ServiceError(404, 'request_not_found')

  if (action === 'decline') {
    await db
      .update(roomJoinRequests)
      .set({ status: 'declined', resolvedAt: new Date() })
      .where(eq(roomJoinRequests.id, request.id))
    registry.sendToAppAccount(caller.appId, request.accountId, {
      type: 'room.join_declined',
      payload: { roomId: roomId as GroupId },
    })
    return
  }

  const activeCount = await countActiveMembers(db, roomId)
  if (activeCount >= room.maxMembers) throw new ServiceError(409, 'room_full')

  await db.transaction(async (tx) => {
    await tx
      .update(roomJoinRequests)
      .set({ status: 'approved', resolvedAt: new Date() })
      .where(eq(roomJoinRequests.id, request.id))
    await tx
      .insert(roomMembers)
      .values({ roomId, accountId: request.accountId, appUserId: request.appUserId })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.accountId],
        set: { status: 'active', joinedAt: new Date(), leftAt: null },
      })
    await touchRoom(tx, roomId)
  })

  registry.sendToAppAccount(caller.appId, request.accountId, {
    type: 'room.join_approved',
    payload: {
      roomId: roomId as GroupId,
      groupInfo: group.groupInfo?.toString('base64') ?? null,
      epoch: group.groupInfoEpoch ?? group.currentEpoch,
    },
  })
  const requesterName = await displayNameOf(db, request.accountId)
  await emitToRoomDevices(db, registry, roomId, {
    type: 'room.member_joined',
    payload: {
      roomId: roomId as GroupId,
      appUserId: request.appUserId as AppUserId,
      displayName: requesterName,
    },
  })
}

/* ------------------------------- moderation ------------------------------- */

export async function kickMember(
  db: Db,
  registry: ConnectionRegistry,
  caller: RoomCaller,
  roomId: string,
  appUserId: string,
): Promise<void> {
  const { room } = await loadRoom(db, caller.appId, roomId)
  if (room.hostAccountId !== caller.accountId) throw new ServiceError(403, 'not_host')
  const target = await db.query.roomMembers.findFirst({
    where: and(
      eq(roomMembers.roomId, roomId),
      eq(roomMembers.appUserId, appUserId),
      eq(roomMembers.status, 'active'),
    ),
  })
  if (!target) throw new ServiceError(404, 'member_not_found')
  if (target.accountId === caller.accountId) throw new ServiceError(400, 'cannot_kick_self')

  // Capture the device recipients BEFORE the host's removal commit lands so
  // the kicked member's devices still receive the event.
  const recipients = await activeMemberDeviceIds(db, roomId)
  await db.transaction(async (tx) => {
    await tx
      .update(roomMembers)
      .set({ status: 'kicked', leftAt: new Date() })
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.accountId, target.accountId)))
    await touchRoom(tx, roomId)
  })
  const message: ServerMessage = {
    type: 'room.member_kicked',
    payload: { roomId: roomId as GroupId, appUserId: appUserId as AppUserId },
  }
  for (const deviceId of recipients) registry.sendToDevice(deviceId, message)
  registry.sendToAppAccount(caller.appId, target.accountId, message)
}

export async function leaveRoom(
  db: Db,
  registry: ConnectionRegistry,
  caller: RoomCaller,
  roomId: string,
): Promise<void> {
  const { room } = await loadRoom(db, caller.appId, roomId)
  const membership = await db.query.roomMembers.findFirst({
    where: and(
      eq(roomMembers.roomId, roomId),
      eq(roomMembers.accountId, caller.accountId),
      eq(roomMembers.status, 'active'),
    ),
  })
  if (!membership) throw new ServiceError(403, 'not_a_member')

  const recipients = await activeMemberDeviceIds(db, roomId)
  await db
    .update(roomMembers)
    .set({ status: 'left', leftAt: new Date() })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.accountId, caller.accountId)))

  const leftMessage: ServerMessage = {
    type: 'room.member_left',
    payload: { roomId: roomId as GroupId, appUserId: caller.appUserId as AppUserId },
  }
  for (const deviceId of recipients) registry.sendToDevice(deviceId, leftMessage)

  if (room.hostAccountId !== caller.accountId) {
    await touchRoom(db, roomId)
    return
  }

  // Host left → immediate migration: the oldest remaining active member
  // becomes host; an empty room closes.
  const remaining = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, 'active')))
    .orderBy(asc(roomMembers.joinedAt))
  const successor = remaining[0]
  if (!successor) {
    await closeRoomInternal(db, registry, roomId, 'empty')
    return
  }
  await db
    .update(rooms)
    .set({ hostAccountId: successor.accountId, lastActivityAt: new Date() })
    .where(eq(rooms.roomId, roomId))
  await emitToRoomDevices(db, registry, roomId, {
    type: 'room.host_changed',
    payload: { roomId: roomId as GroupId, hostAppUserId: successor.appUserId as AppUserId },
  })
}

export async function setPhase(
  db: Db,
  registry: ConnectionRegistry,
  caller: RoomCaller,
  roomId: string,
  phase: 'open' | 'in_progress',
): Promise<void> {
  const { room } = await loadRoom(db, caller.appId, roomId)
  if (room.hostAccountId !== caller.accountId) throw new ServiceError(403, 'not_host')
  if (room.phase === 'closed') throw new ServiceError(409, 'room_closed')
  await db.update(rooms).set({ phase, lastActivityAt: new Date() }).where(eq(rooms.roomId, roomId))
  await emitToRoomDevices(db, registry, roomId, {
    type: 'room.phase',
    payload: { roomId: roomId as GroupId, phase },
  })
}

export async function closeRoom(
  db: Db,
  registry: ConnectionRegistry,
  caller: RoomCaller,
  roomId: string,
): Promise<void> {
  const { room } = await loadRoom(db, caller.appId, roomId)
  if (room.hostAccountId !== caller.accountId) throw new ServiceError(403, 'not_host')
  if (room.phase === 'closed') return
  await closeRoomInternal(db, registry, roomId, 'closed_by_host')
}

async function closeRoomInternal(
  db: Db,
  registry: ConnectionRegistry,
  roomId: string,
  reason: string,
): Promise<void> {
  const recipients = await activeMemberDeviceIds(db, roomId)
  await db
    .update(rooms)
    .set({ phase: 'closed', closedAt: new Date(), lastActivityAt: new Date() })
    .where(eq(rooms.roomId, roomId))
  const message: ServerMessage = {
    type: 'room.closed',
    payload: { roomId: roomId as GroupId, reason },
  }
  for (const deviceId of recipients) registry.sendToDevice(deviceId, message)
}

/* -------------------------------- pruning --------------------------------- */

/**
 * Housekeeping (hourly): expire stale join requests, close idle rooms, and
 * hard-delete rooms closed longer than the retention window (including their
 * mailbox, leaves, cursors, welcomes and the groups row).
 */
export async function pruneRooms(db: Db): Promise<{ closed: number; deleted: number }> {
  await db
    .update(roomJoinRequests)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(
      and(
        eq(roomJoinRequests.status, 'pending'),
        lt(roomJoinRequests.createdAt, new Date(Date.now() - ROOM_JOIN_REQUEST_TTL_MS)),
      ),
    )

  const idleCutoff = new Date(Date.now() - ROOM_INACTIVE_EXPIRE_DAYS * 24 * 3600 * 1000)
  const closedRows = await db
    .update(rooms)
    .set({ phase: 'closed', closedAt: new Date() })
    .where(and(ne(rooms.phase, 'closed'), lt(rooms.lastActivityAt, idleCutoff)))
    .returning({ roomId: rooms.roomId })

  const deleteCutoff = new Date(Date.now() - ROOM_CLOSED_RETENTION_DAYS * 24 * 3600 * 1000)
  const dead = await db
    .select({ roomId: rooms.roomId })
    .from(rooms)
    .where(and(eq(rooms.phase, 'closed'), lt(rooms.closedAt, deleteCutoff)))
  const deadIds = dead.map((r) => r.roomId)
  if (deadIds.length > 0) {
    await db.transaction(async (tx) => {
      await tx.delete(roomJoinRequests).where(inArray(roomJoinRequests.roomId, deadIds))
      await tx.delete(roomMembers).where(inArray(roomMembers.roomId, deadIds))
      await tx.delete(mlsCursors).where(inArray(mlsCursors.groupId, deadIds))
      await tx.delete(mlsMessages).where(inArray(mlsMessages.groupId, deadIds))
      await tx.delete(welcomes).where(inArray(welcomes.groupId, deadIds))
      await tx.delete(groupMembers).where(inArray(groupMembers.groupId, deadIds))
      await tx.delete(rooms).where(inArray(rooms.roomId, deadIds))
      await tx.delete(groups).where(inArray(groups.groupId, deadIds))
    })
  }
  return { closed: closedRows.length, deleted: deadIds.length }
}

/* -------------------------------- helpers --------------------------------- */

type RoomRow = typeof rooms.$inferSelect
type GroupRow = typeof groups.$inferSelect

async function loadRoom(
  db: Db,
  appId: string,
  roomId: string,
): Promise<{ room: RoomRow; group: GroupRow }> {
  const room = await db.query.rooms.findFirst({ where: eq(rooms.roomId, roomId) })
  if (!room || room.pubId !== appId) throw new ServiceError(404, 'room_not_found')
  const group = await db.query.groups.findFirst({ where: eq(groups.groupId, roomId) })
  if (!group) throw new ServiceError(404, 'room_not_found')
  return { room, group }
}

async function countActiveMembers(db: Db, roomId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, 'active')))
  return rows[0]?.count ?? 0
}

/** Devices that currently hold an MLS leaf in the room (user + app devices). */
export async function activeMemberDeviceIds(db: Db, groupId: string): Promise<string[]> {
  const rows = await db
    .select({ deviceId: groupMembers.deviceId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), isNull(groupMembers.removedEpoch)))
  return rows.map((r) => r.deviceId)
}

async function emitToRoomDevices(
  db: Db,
  registry: ConnectionRegistry,
  groupId: string,
  message: ServerMessage,
  exceptDevice?: string,
): Promise<void> {
  for (const deviceId of await activeMemberDeviceIds(db, groupId)) {
    if (deviceId === exceptDevice) continue
    registry.sendToDevice(deviceId, message)
  }
}

async function displayNameOf(db: Db, accountId: string): Promise<string> {
  const row = await db.query.accounts.findFirst({ where: eq(accounts.accountId, accountId) })
  return row?.displayName ?? ''
}

type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

async function touchRoom(tx: DbOrTx, roomId: string): Promise<void> {
  await tx.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.roomId, roomId))
}
