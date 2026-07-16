import { randomBytes } from 'node:crypto'
import type {
  AccountId,
  ClaimedKeyPackage,
  DeviceId,
  GroupId,
  GroupSummary,
  MailboxMessage,
  PendingWelcome,
  PostCommitRequest,
  UploadKeyPackagesRequest,
} from '@gathernet/shared'
import { KEY_PACKAGE_TTL_DAYS, MAILBOX_RETENTION_DAYS, ROOM_MAX_DEVICES } from '@gathernet/shared'
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  appDevices,
  communityChannels,
  communityMembers,
  devices,
  groupMembers,
  groups,
  keyPackages,
  mlsCursors,
  mlsMessages,
  roomMembers,
  rooms,
  welcomes,
} from '../../db/schema.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import { friendAccountIds } from '../friends/service.ts'

/** Epoch conflict — client must catch up and rebuild its commit. */
export class EpochConflictError extends ServiceError {
  constructor(readonly currentEpoch: number) {
    super(409, 'epoch_conflict')
  }
}

/**
 * Whether a community member row grants access to a channel at the given
 * level. 'members' channels admit any active member; 'leaders' channels admit
 * only active owners/leaders. This is the ADR-0001 "leaders channel" guard —
 * enforced on GroupInfo release AND commit authorization (defense in depth).
 */
export function satisfiesChannelAccess(
  member: { role: string; status: string } | undefined,
  access: string,
): boolean {
  if (member?.status !== 'active') return false
  if (access === 'leaders') return member.role === 'owner' || member.role === 'leader'
  return true
}

export async function createDmGroup(
  db: Db,
  registry: ConnectionRegistry,
  inviterAccountId: string,
  accepterAccountId: string,
): Promise<string> {
  const groupId = randomBytes(16).toString('hex')
  const pair =
    inviterAccountId < accepterAccountId
      ? { accountA: inviterAccountId, accountB: accepterAccountId }
      : { accountA: accepterAccountId, accountB: inviterAccountId }
  await db.insert(groups).values({
    groupId,
    kind: 'dm',
    ...pair,
    // The accepter's online device creates the MLS group — fixed rule, no races.
    creatorAccountId: accepterAccountId,
  })
  for (const [self, other] of [
    [inviterAccountId, accepterAccountId],
    [accepterAccountId, inviterAccountId],
  ] as const) {
    registry.sendToAccount(self, {
      type: 'group.created',
      payload: {
        groupId: groupId as GroupId,
        friendAccountId: other as AccountId,
        creator: self === accepterAccountId,
      },
    })
  }
  return groupId
}

export async function uploadKeyPackages(
  db: Db,
  deviceId: string,
  body: UploadKeyPackagesRequest,
): Promise<number> {
  const notAfter = new Date(Date.now() + KEY_PACKAGE_TTL_DAYS * 24 * 3600 * 1000)
  await db
    .insert(keyPackages)
    .values(
      body.keyPackages.map((kp) => ({
        ref: kp.ref,
        deviceId,
        data: Buffer.from(kp.data, 'base64'),
        isLastResort: kp.isLastResort,
        notAfter,
      })),
    )
    .onConflictDoNothing()
  return countKeyPackages(db, deviceId)
}

export async function countKeyPackages(db: Db, deviceId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(keyPackages)
    .where(
      and(
        eq(keyPackages.deviceId, deviceId),
        isNull(keyPackages.consumedAt),
        eq(keyPackages.isLastResort, false),
        gt(keyPackages.notAfter, new Date()),
      ),
    )
  return rows[0]?.count ?? 0
}

/**
 * One key package per active device of each target account, excluding the
 * caller's own device. Targets must be the caller's own account or friends.
 */
export async function claimKeyPackages(
  db: Db,
  callerAccountId: string,
  callerDeviceId: string,
  accountIds: string[],
): Promise<ClaimedKeyPackage[]> {
  const friends = new Set(await friendAccountIds(db, callerAccountId))
  for (const target of accountIds) {
    if (target !== callerAccountId && !friends.has(target)) {
      throw new ServiceError(403, 'not_friends')
    }
  }

  const targetDevices = await db
    .select({ deviceId: devices.deviceId, accountId: devices.accountId })
    .from(devices)
    .where(and(inArray(devices.accountId, accountIds), eq(devices.status, 'active')))

  const claimed: ClaimedKeyPackage[] = []
  for (const device of targetDevices) {
    if (device.deviceId === callerDeviceId) continue
    const kp = await claimOne(db, device.deviceId, callerAccountId)
    if (kp) {
      claimed.push({
        accountId: device.accountId as AccountId,
        deviceId: device.deviceId as DeviceId,
        ref: kp.ref,
        data: kp.data.toString('base64'),
      })
    }
  }
  return claimed
}

async function claimOne(
  db: Db,
  deviceId: string,
  claimerAccountId: string,
): Promise<{ ref: string; data: Buffer } | null> {
  return db.transaction(async (tx) => {
    const picked = await tx.execute(sql`
      SELECT ref, data FROM key_packages
      WHERE device_id = ${deviceId} AND consumed_at IS NULL
        AND is_last_resort = false AND not_after > now()
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `)
    const row = picked.rows[0] as { ref: string; data: Buffer } | undefined
    if (row) {
      await tx
        .update(keyPackages)
        .set({ consumedBy: claimerAccountId, consumedAt: new Date() })
        .where(eq(keyPackages.ref, row.ref))
      return { ref: row.ref, data: row.data }
    }
    // Pool empty → last-resort key package (reusable, never consumed).
    const lastResort = await tx
      .select({ ref: keyPackages.ref, data: keyPackages.data })
      .from(keyPackages)
      .where(
        and(
          eq(keyPackages.deviceId, deviceId),
          eq(keyPackages.isLastResort, true),
          gt(keyPackages.notAfter, new Date()),
        ),
      )
      .limit(1)
    return lastResort[0] ?? null
  })
}

export async function listGroups(
  db: Db,
  accountId: string,
  deviceId: string,
): Promise<GroupSummary[]> {
  const rows = await db
    .select()
    .from(groups)
    .leftJoin(
      groupMembers,
      and(
        eq(groupMembers.groupId, groups.groupId),
        eq(groupMembers.deviceId, deviceId),
        isNull(groupMembers.removedEpoch),
      ),
    )
    .where(
      and(
        eq(groups.kind, 'dm'),
        or(eq(groups.accountA, accountId), eq(groups.accountB, accountId)),
      ),
    )
    .orderBy(asc(groups.createdAt))

  return rows.map((r) => ({
    groupId: r.groups.groupId as GroupId,
    kind: 'dm' as const,
    friendAccountId: ((r.groups.accountA === accountId ? r.groups.accountB : r.groups.accountA) ??
      '') as AccountId,
    creator: r.groups.creatorAccountId === accountId,
    currentEpoch: r.groups.currentEpoch,
    groupInfo: r.groups.groupInfo?.toString('base64') ?? null,
    isMember: r.group_members !== null,
  }))
}

export interface CommitFanout {
  seq: number
  newEpoch: number
  /** devices that must receive the commit */
  commitRecipients: string[]
  /** welcome rows inserted, keyed by recipient */
  welcomeRecipients: { deviceId: string; welcomeId: number; payload: string }[]
  senderDevice: string
  payload: string
}

export async function postCommit(
  db: Db,
  accountId: string,
  deviceId: string,
  groupId: string,
  body: PostCommitRequest,
): Promise<CommitFanout> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT * FROM groups WHERE group_id = ${groupId} FOR UPDATE`,
    )
    const group = locked.rows[0] as
      | {
          group_id: string
          kind: string
          account_a: string | null
          account_b: string | null
          current_epoch: number
          last_seq: number
        }
      | undefined
    if (!group) throw new ServiceError(404, 'group_not_found')
    const isRoom = group.kind === 'room'
    const isChannel = group.kind === 'channel'

    // Sender authorization by group kind. Rooms: any account with an ACTIVE
    // room_members row (external joiners included — the join endpoint inserts
    // the row before their commit). Channels: any account whose community
    // membership satisfies the channel access level (leaders-only channels
    // reject plain members even if they somehow hold the GroupInfo). DMs: one
    // of the two pair accounts.
    let roomHostAccountId: string | null = null
    let roomPubId: string | null = null
    /** room member status per account, for adds/removes validation */
    const roomStatus = new Map<string, string>()
    let channelAccess: string | null = null
    /** community membership (role+status) per account, for channel validation */
    const channelMembers = new Map<string, { role: string; status: string }>()
    if (isRoom) {
      const memberRows = await tx.select().from(roomMembers).where(eq(roomMembers.roomId, groupId))
      for (const m of memberRows) roomStatus.set(m.accountId, m.status)
      if (roomStatus.get(accountId) !== 'active') {
        throw new ServiceError(404, 'group_not_found')
      }
      const roomRow = await tx.query.rooms.findFirst({ where: eq(rooms.roomId, groupId) })
      roomHostAccountId = roomRow?.hostAccountId ?? null
      roomPubId = roomRow?.pubId ?? null
    } else if (isChannel) {
      const channel = await tx.query.communityChannels.findFirst({
        where: eq(communityChannels.channelId, groupId),
      })
      if (!channel) throw new ServiceError(404, 'group_not_found')
      channelAccess = channel.access
      const memberRows = await tx
        .select()
        .from(communityMembers)
        .where(eq(communityMembers.communityId, channel.communityId))
      for (const m of memberRows)
        channelMembers.set(m.accountId, { role: m.role, status: m.status })
      // Don't leak channel existence to unauthorized callers.
      if (!satisfiesChannelAccess(channelMembers.get(accountId), channelAccess)) {
        throw new ServiceError(404, 'group_not_found')
      }
    } else if (group.account_a !== accountId && group.account_b !== accountId) {
      throw new ServiceError(404, 'group_not_found')
    }

    if (body.epoch !== group.current_epoch) {
      throw new EpochConflictError(group.current_epoch)
    }
    const newEpoch = group.current_epoch + 1
    const seq = group.last_seq + 1

    // Current membership before this commit.
    const membersBefore = await tx
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), isNull(groupMembers.removedEpoch)))
    const memberDevices = new Set(membersBefore.map((m) => m.deviceId))
    const accountOfLeaf = new Map(membersBefore.map((m) => [m.deviceId, m.accountId]))

    // Sender must be a current member, be joining via this commit (external
    // join), or — dm only — be making the group's very first commit as the
    // creator side. Rooms and channels bootstrap through the group-info
    // publish instead.
    const senderIsMember = memberDevices.has(deviceId)
    const senderJoins = (body.memberChanges.adds as string[]).includes(deviceId)
    const firstCommit = group.kind === 'dm' && membersBefore.length === 0
    if (!senderIsMember && !senderJoins && !firstCommit) {
      throw new ServiceError(403, 'not_a_member')
    }

    // Every added/welcomed device must belong to an authorized account:
    // dm → the two pair accounts (real devices only); room → any account
    // with an active room_members row (real devices OR this app's devices);
    // channel → any account (real devices only) whose community membership
    // satisfies the channel access level.
    const referenced = [
      ...new Set([...body.memberChanges.adds, ...body.welcomes.map((w) => w.deviceId)]),
    ]
    const deviceOwner = new Map<string, string>()
    if (referenced.length > 0) {
      const realRows = await tx
        .select({ deviceId: devices.deviceId, accountId: devices.accountId })
        .from(devices)
        .where(and(inArray(devices.deviceId, referenced), eq(devices.status, 'active')))
      for (const r of realRows) deviceOwner.set(r.deviceId, r.accountId)
      if (isRoom) {
        const appRows = await tx
          .select({ deviceId: appDevices.deviceId, accountId: appDevices.accountId })
          .from(appDevices)
          .where(
            and(inArray(appDevices.deviceId, referenced), eq(appDevices.pubId, roomPubId ?? '')),
          )
        for (const r of appRows) deviceOwner.set(r.deviceId, r.accountId)
      }
      for (const ref of referenced) {
        const owner = deviceOwner.get(ref)
        let authorized: boolean
        if (isRoom) authorized = owner !== undefined && roomStatus.get(owner) === 'active'
        else if (isChannel)
          authorized =
            owner !== undefined &&
            satisfiesChannelAccess(channelMembers.get(owner), channelAccess ?? 'members')
        else authorized = owner === group.account_a || owner === group.account_b
        if (!authorized) throw new ServiceError(400, 'invalid_member_change')
      }
    }

    // Rooms: removals come from the host, or only affect devices whose
    // accounts already left / were kicked (cleanup by any member).
    if (isRoom && body.memberChanges.removes.length > 0) {
      const committerIsHost = accountId === roomHostAccountId
      if (!committerIsHost) {
        for (const removeId of body.memberChanges.removes) {
          const owner = accountOfLeaf.get(removeId)
          const ownerStatus = owner ? roomStatus.get(owner) : undefined
          if (ownerStatus !== 'left' && ownerStatus !== 'kicked') {
            throw new ServiceError(403, 'remove_not_allowed')
          }
        }
      }
    }

    // Channels: leaders/owner may remove anyone; a plain member may only
    // remove leaves whose owner no longer satisfies access (cleanup after a
    // member was removed/demoted at the community level).
    if (isChannel && body.memberChanges.removes.length > 0) {
      const committer = channelMembers.get(accountId)
      const committerIsLeader = committer?.role === 'owner' || committer?.role === 'leader'
      if (!committerIsLeader) {
        for (const removeId of body.memberChanges.removes) {
          const owner = accountOfLeaf.get(removeId)
          if (
            owner &&
            satisfiesChannelAccess(channelMembers.get(owner), channelAccess ?? 'members')
          ) {
            throw new ServiceError(403, 'remove_not_allowed')
          }
        }
      }
    }

    const adds = new Set<string>(body.memberChanges.adds)
    if ((firstCommit || senderJoins) && !adds.has(deviceId)) adds.add(deviceId)

    // Rooms: hard cap on active MLS leaves.
    if (isRoom) {
      const leavesAfter = new Set(memberDevices)
      for (const removeId of body.memberChanges.removes) leavesAfter.delete(removeId)
      for (const addId of adds) leavesAfter.add(addId)
      if (leavesAfter.size > ROOM_MAX_DEVICES) {
        throw new ServiceError(409, 'device_limit')
      }
    }

    await tx
      .update(groups)
      .set({
        currentEpoch: newEpoch,
        lastSeq: seq,
        groupInfo: Buffer.from(body.groupInfo, 'base64'),
        groupInfoEpoch: newEpoch,
      })
      .where(eq(groups.groupId, groupId))
    if (isRoom) {
      await tx.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.roomId, groupId))
    }

    await tx.insert(mlsMessages).values({
      groupId,
      seq,
      kind: 'commit',
      epoch: body.epoch,
      senderDevice: deviceId,
      payload: Buffer.from(body.commit, 'base64'),
    })

    const accountOfDevice = async (id: string): Promise<string> => {
      const known = deviceOwner.get(id)
      if (known) return known
      const row = await tx.query.devices.findFirst({ where: eq(devices.deviceId, id) })
      if (row) return row.accountId
      if (isRoom) {
        const appRow = await tx.query.appDevices.findFirst({
          where: eq(appDevices.deviceId, id),
        })
        if (appRow) return appRow.accountId
      }
      throw new ServiceError(400, 'invalid_member_change')
    }
    for (const addId of adds) {
      await tx
        .insert(groupMembers)
        .values({
          groupId,
          deviceId: addId,
          accountId: await accountOfDevice(addId),
          addedEpoch: newEpoch,
        })
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.deviceId],
          set: { addedEpoch: newEpoch, removedEpoch: null },
        })
    }
    for (const removeId of body.memberChanges.removes) {
      await tx
        .update(groupMembers)
        .set({ removedEpoch: newEpoch })
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.deviceId, removeId),
            isNull(groupMembers.removedEpoch),
          ),
        )
    }

    const welcomeRecipients: CommitFanout['welcomeRecipients'] = []
    for (const welcome of body.welcomes) {
      const [row] = await tx
        .insert(welcomes)
        .values({
          recipientDevice: welcome.deviceId,
          groupId,
          payload: Buffer.from(welcome.payload, 'base64'),
        })
        .returning({ id: welcomes.id })
      if (row) {
        welcomeRecipients.push({
          deviceId: welcome.deviceId,
          welcomeId: row.id,
          payload: welcome.payload,
        })
      }
    }

    // The commit fans out to everyone who was a member before it (including
    // members it removes, so they learn about their removal) — minus sender.
    const commitRecipients = [...memberDevices].filter((d) => d !== deviceId)

    return {
      seq,
      newEpoch,
      commitRecipients,
      welcomeRecipients,
      senderDevice: deviceId,
      payload: body.commit,
    }
  })
}

export interface MessageFanout {
  seq: number
  epoch: number
  recipients: string[]
  senderDevice: string
  payload: string
}

export async function postMessage(
  db: Db,
  deviceId: string,
  groupId: string,
  epoch: number,
  payloadB64: string,
): Promise<MessageFanout> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT kind, current_epoch, last_seq FROM groups WHERE group_id = ${groupId} FOR UPDATE`,
    )
    const group = locked.rows[0] as
      | { kind: string; current_epoch: number; last_seq: number }
      | undefined
    if (!group) throw new ServiceError(404, 'group_not_found')

    const members = await tx
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), isNull(groupMembers.removedEpoch)))
    const senderRow = members.find((m) => m.deviceId === deviceId)
    if (!senderRow) {
      throw new ServiceError(403, 'not_a_member')
    }
    // Channels: defense in depth — a leaf whose owner was removed/demoted (but
    // not yet cryptographically removed) must not be able to send.
    if (group.kind === 'channel') {
      const channel = await tx.query.communityChannels.findFirst({
        where: eq(communityChannels.channelId, groupId),
      })
      const membership = channel
        ? await tx.query.communityMembers.findFirst({
            where: and(
              eq(communityMembers.communityId, channel.communityId),
              eq(communityMembers.accountId, senderRow.accountId),
            ),
          })
        : undefined
      if (!channel || !satisfiesChannelAccess(membership ?? undefined, channel.access)) {
        throw new ServiceError(403, 'not_a_member')
      }
    }
    // Accept the current epoch and one behind (commit racing a message).
    if (epoch !== group.current_epoch && epoch !== group.current_epoch - 1) {
      throw new EpochConflictError(group.current_epoch)
    }

    const seq = group.last_seq + 1
    await tx.update(groups).set({ lastSeq: seq }).where(eq(groups.groupId, groupId))
    if (group.kind === 'room') {
      await tx.update(rooms).set({ lastActivityAt: new Date() }).where(eq(rooms.roomId, groupId))
    }
    await tx.insert(mlsMessages).values({
      groupId,
      seq,
      kind: 'application',
      epoch,
      senderDevice: deviceId,
      payload: Buffer.from(payloadB64, 'base64'),
    })

    return {
      seq,
      epoch,
      recipients: members.map((m) => m.deviceId).filter((d) => d !== deviceId),
      senderDevice: deviceId,
      payload: payloadB64,
    }
  })
}

export async function listMessages(
  db: Db,
  accountId: string,
  groupId: string,
  afterSeq: number,
): Promise<MailboxMessage[]> {
  const group = await db.query.groups.findFirst({ where: eq(groups.groupId, groupId) })
  if (!group) throw new ServiceError(404, 'group_not_found')
  if (group.kind === 'room') {
    const membership = await db.query.roomMembers.findFirst({
      where: and(
        eq(roomMembers.roomId, groupId),
        eq(roomMembers.accountId, accountId),
        eq(roomMembers.status, 'active'),
      ),
    })
    if (!membership) throw new ServiceError(404, 'group_not_found')
  } else if (group.kind === 'channel') {
    const channel = await db.query.communityChannels.findFirst({
      where: eq(communityChannels.channelId, groupId),
    })
    const membership = channel
      ? await db.query.communityMembers.findFirst({
          where: and(
            eq(communityMembers.communityId, channel.communityId),
            eq(communityMembers.accountId, accountId),
          ),
        })
      : undefined
    if (!channel || !satisfiesChannelAccess(membership ?? undefined, channel.access)) {
      throw new ServiceError(404, 'group_not_found')
    }
  } else if (group.accountA !== accountId && group.accountB !== accountId) {
    throw new ServiceError(404, 'group_not_found')
  }
  const rows = await db
    .select()
    .from(mlsMessages)
    .where(and(eq(mlsMessages.groupId, groupId), gt(mlsMessages.seq, afterSeq)))
    .orderBy(asc(mlsMessages.seq))
  return rows.map((m) => ({
    groupId: m.groupId as GroupId,
    seq: m.seq,
    kind: m.kind,
    epoch: m.epoch,
    senderDevice: m.senderDevice as DeviceId,
    payload: m.payload.toString('base64'),
    sentAt: m.createdAt.getTime(),
  }))
}

export async function ackCursor(
  db: Db,
  deviceId: string,
  groupId: string,
  seq: number,
): Promise<void> {
  await db
    .insert(mlsCursors)
    .values({ groupId, deviceId, ackedSeq: seq })
    .onConflictDoUpdate({
      target: [mlsCursors.groupId, mlsCursors.deviceId],
      set: { ackedSeq: sql`GREATEST(${mlsCursors.ackedSeq}, ${seq})` },
    })
}

export async function listWelcomes(db: Db, deviceId: string): Promise<PendingWelcome[]> {
  const rows = await db
    .select()
    .from(welcomes)
    .where(eq(welcomes.recipientDevice, deviceId))
    .orderBy(asc(welcomes.id))
  return rows.map((w) => ({
    welcomeId: w.id,
    groupId: w.groupId as GroupId,
    payload: w.payload.toString('base64'),
  }))
}

export async function ackWelcome(db: Db, deviceId: string, welcomeId: number): Promise<void> {
  await db
    .delete(welcomes)
    .where(and(eq(welcomes.id, welcomeId), eq(welcomes.recipientDevice, deviceId)))
}

export async function helloInfo(
  db: Db,
  deviceId: string,
): Promise<{ kpRemaining: number; pending: { welcomes: number; messages: number } }> {
  const kpRemaining = await countKeyPackages(db, deviceId)
  const welcomeCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(welcomes)
    .where(eq(welcomes.recipientDevice, deviceId))
  const pendingMessages = await db.execute(sql`
    SELECT COALESCE(SUM(g.last_seq - COALESCE(c.acked_seq, 0)), 0)::int AS pending
    FROM group_members gm
    JOIN groups g ON g.group_id = gm.group_id
    LEFT JOIN mls_cursors c ON c.group_id = gm.group_id AND c.device_id = gm.device_id
    WHERE gm.device_id = ${deviceId} AND gm.removed_epoch IS NULL
  `)
  return {
    kpRemaining,
    pending: {
      welcomes: welcomeCount[0]?.count ?? 0,
      messages: Number((pendingMessages.rows[0] as { pending?: number })?.pending ?? 0),
    },
  }
}

/** Delete fully-acked or expired mailbox rows. Run periodically. */
export async function pruneMailbox(db: Db): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM mls_messages m
    WHERE m.created_at < now() - make_interval(days => ${MAILBOX_RETENTION_DAYS})
       OR NOT EXISTS (
         SELECT 1 FROM group_members gm
         WHERE gm.group_id = m.group_id
           AND gm.removed_epoch IS NULL
           AND gm.device_id <> m.sender_device
           AND COALESCE((SELECT c.acked_seq FROM mls_cursors c
                         WHERE c.group_id = gm.group_id AND c.device_id = gm.device_id), 0) < m.seq
       )
  `)
  return result.rowCount ?? 0
}
