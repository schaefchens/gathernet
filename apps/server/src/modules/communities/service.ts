import { randomBytes } from 'node:crypto'
import type {
  AccountId,
  ChannelJoinInfoResponse,
  CommunityDetailResponse,
  CommunityId,
  CommunityListItem,
  CreateChannelRequest,
  CreateCommunityInviteRequest,
  CreateCommunityRequest,
  GroupId,
  ServerMessage,
  UpdateCommunityRequest,
} from '@gathernet/shared'
import { INVITE_CODE_LENGTH } from '@gathernet/shared'
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  accounts,
  communities,
  communityChannels,
  communityInvites,
  communityMembers,
  devices,
  groupMembers,
  groups,
  mlsCursors,
  mlsMessages,
  welcomes,
} from '../../db/schema.ts'
import { newCrockfordCode, newHexId } from '../../lib/codes.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import { satisfiesChannelAccess } from '../delivery/service.ts'

type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]
type MemberRow = typeof communityMembers.$inferSelect

/* ------------------------------- membership ------------------------------- */

/** Active membership row, or 404 (never leak community existence). */
async function requireActiveMembership(
  db: Db,
  communityId: string,
  accountId: string,
): Promise<MemberRow> {
  const row = await db.query.communityMembers.findFirst({
    where: and(
      eq(communityMembers.communityId, communityId),
      eq(communityMembers.accountId, accountId),
    ),
  })
  if (row?.status !== 'active') throw new ServiceError(404, 'community_not_found')
  return row
}

function requireLeader(row: MemberRow): void {
  if (row.role !== 'owner' && row.role !== 'leader') throw new ServiceError(403, 'not_a_leader')
}

function requireOwner(row: MemberRow): void {
  if (row.role !== 'owner') throw new ServiceError(403, 'not_owner')
}

async function activeMemberAccountIds(db: DbOrTx, communityId: string): Promise<string[]> {
  const rows = await db
    .select({ accountId: communityMembers.accountId })
    .from(communityMembers)
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, 'active')),
    )
  return rows.map((r) => r.accountId)
}

async function emitToMembers(
  db: DbOrTx,
  registry: ConnectionRegistry,
  communityId: string,
  message: ServerMessage,
  extraAccounts: string[] = [],
): Promise<void> {
  const recipients = new Set([...(await activeMemberAccountIds(db, communityId)), ...extraAccounts])
  for (const accountId of recipients) registry.sendToAccount(accountId, message)
}

async function displayNameOf(db: DbOrTx, accountId: string): Promise<string> {
  const row = await db.query.accounts.findFirst({ where: eq(accounts.accountId, accountId) })
  return row?.displayName ?? ''
}

/* -------------------------------- community ------------------------------- */

export async function createCommunity(
  db: Db,
  accountId: string,
  input: CreateCommunityRequest,
): Promise<{ communityId: string }> {
  const communityId = newHexId('cm', 8)
  await db.transaction(async (tx) => {
    await tx.insert(communities).values({
      communityId,
      name: input.name,
      description: input.description ?? null,
      iconUrl: input.iconUrl ?? null,
      ownerAccountId: accountId,
    })
    await tx.insert(communityMembers).values({
      communityId,
      accountId,
      role: 'owner',
      status: 'active',
    })
  })
  return { communityId }
}

export async function listCommunities(db: Db, accountId: string): Promise<CommunityListItem[]> {
  const rows = await db
    .select({
      communityId: communities.communityId,
      name: communities.name,
      description: communities.description,
      iconUrl: communities.iconUrl,
      role: communityMembers.role,
      channelCount: sql<number>`(
        SELECT count(*)::int FROM community_channels cc
        WHERE cc.community_id = ${communities.communityId}
      )`,
      createdAt: communities.createdAt,
    })
    .from(communityMembers)
    .innerJoin(communities, eq(communities.communityId, communityMembers.communityId))
    .where(and(eq(communityMembers.accountId, accountId), eq(communityMembers.status, 'active')))
    .orderBy(asc(communities.createdAt))

  return rows.map((r) => ({
    communityId: r.communityId as CommunityId,
    name: r.name,
    description: r.description,
    iconUrl: r.iconUrl,
    myRole: r.role,
    channelCount: r.channelCount,
  }))
}

export async function getCommunityDetail(
  db: Db,
  accountId: string,
  communityId: string,
): Promise<CommunityDetailResponse> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')

  const memberRows = await db
    .select({
      accountId: communityMembers.accountId,
      role: communityMembers.role,
      displayName: accounts.displayName,
      joinedAt: communityMembers.joinedAt,
    })
    .from(communityMembers)
    .innerJoin(accounts, eq(accounts.accountId, communityMembers.accountId))
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, 'active')),
    )
    .orderBy(asc(communityMembers.joinedAt))

  const isLeader = membership.role === 'owner' || membership.role === 'leader'
  const channelRows = await db
    .select({
      channelId: communityChannels.channelId,
      name: communityChannels.name,
      access: communityChannels.access,
      position: communityChannels.position,
      currentEpoch: groups.currentEpoch,
      groupInfo: groups.groupInfo,
      joined: sql<boolean>`EXISTS (
        SELECT 1 FROM group_members gm
        WHERE gm.group_id = ${communityChannels.channelId}
          AND gm.account_id = ${accountId} AND gm.removed_epoch IS NULL
      )`,
      createdAt: communityChannels.createdAt,
    })
    .from(communityChannels)
    .innerJoin(groups, eq(groups.groupId, communityChannels.channelId))
    .where(eq(communityChannels.communityId, communityId))
    .orderBy(asc(communityChannels.position), asc(communityChannels.createdAt))

  return {
    community: {
      communityId: community.communityId as CommunityId,
      name: community.name,
      description: community.description,
      iconUrl: community.iconUrl,
      ownerAccountId: community.ownerAccountId as AccountId,
    },
    myRole: membership.role,
    members: memberRows.map((m) => ({
      accountId: m.accountId as AccountId,
      displayName: m.displayName,
      role: m.role,
    })),
    channels: channelRows
      .filter((c) => isLeader || c.access === 'members')
      .map((c) => ({
        channelId: c.channelId as GroupId,
        name: c.name,
        access: c.access,
        position: c.position,
        joined: c.joined,
        currentEpoch: c.currentEpoch,
        groupInfo: c.groupInfo?.toString('base64') ?? null,
      })),
  }
}

export async function updateCommunity(
  db: Db,
  accountId: string,
  communityId: string,
  input: UpdateCommunityRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const patch: Partial<typeof communities.$inferInsert> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description
  if (input.iconUrl !== undefined) patch.iconUrl = input.iconUrl
  await db.update(communities).set(patch).where(eq(communities.communityId, communityId))
}

/* --------------------------------- invites -------------------------------- */

export async function createCommunityInvite(
  db: Db,
  accountId: string,
  communityId: string,
  options: CreateCommunityInviteRequest,
) {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const [row] = await db
    .insert(communityInvites)
    .values({
      communityId,
      creatorAccountId: accountId,
      code: newCrockfordCode(INVITE_CODE_LENGTH),
      maxUses: options.maxUses,
      expiresAt: new Date(Date.now() + options.ttlHours * 3600 * 1000),
    })
    .returning()
  if (!row) throw new ServiceError(500, 'internal')
  return toInviteDto(row)
}

export async function listCommunityInvites(db: Db, accountId: string, communityId: string) {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const rows = await db
    .select()
    .from(communityInvites)
    .where(
      and(
        eq(communityInvites.communityId, communityId),
        isNull(communityInvites.revokedAt),
        gt(communityInvites.expiresAt, new Date()),
        lt(communityInvites.useCount, communityInvites.maxUses),
      ),
    )
    .orderBy(asc(communityInvites.createdAt))
  return rows.map(toInviteDto)
}

export async function revokeCommunityInvite(
  db: Db,
  accountId: string,
  communityId: string,
  inviteId: string,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const updated = await db
    .update(communityInvites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(communityInvites.id, inviteId),
        eq(communityInvites.communityId, communityId),
        isNull(communityInvites.revokedAt),
      ),
    )
    .returning({ id: communityInvites.id })
  if (updated.length === 0) throw new ServiceError(404, 'invite_not_found')
}

export async function acceptCommunityInvite(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  code: string,
): Promise<{ communityId: string }> {
  const communityId = await db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(communityInvites)
      .where(eq(communityInvites.code, code))
      .for('update')
    if (
      !invite ||
      invite.revokedAt !== null ||
      invite.expiresAt <= new Date() ||
      invite.useCount >= invite.maxUses
    ) {
      throw new ServiceError(404, 'invite_invalid')
    }

    const existing = await tx.query.communityMembers.findFirst({
      where: and(
        eq(communityMembers.communityId, invite.communityId),
        eq(communityMembers.accountId, accountId),
      ),
    })
    if (existing?.status === 'active') throw new ServiceError(409, 'already_member')

    // Rejoin (previously left/removed) resets to an active member — M2 has no
    // ban list, so a fresh invite is sufficient authorization.
    await tx
      .insert(communityMembers)
      .values({ communityId: invite.communityId, accountId, role: 'member', status: 'active' })
      .onConflictDoUpdate({
        target: [communityMembers.communityId, communityMembers.accountId],
        set: { role: 'member', status: 'active', joinedAt: new Date(), leftAt: null },
      })
    await tx
      .update(communityInvites)
      .set({ useCount: sql`${communityInvites.useCount} + 1` })
      .where(eq(communityInvites.id, invite.id))
    return invite.communityId
  })

  const displayName = await displayNameOf(db, accountId)
  await emitToMembers(db, registry, communityId, {
    type: 'community.member_joined',
    payload: {
      communityId: communityId as CommunityId,
      accountId: accountId as AccountId,
      displayName,
    },
  })
  return { communityId }
}

/* -------------------------------- channels -------------------------------- */

export async function createChannel(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  input: CreateChannelRequest,
): Promise<{ channelId: string }> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const channelId = randomBytes(16).toString('hex')
  await db.transaction(async (tx) => {
    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(communityChannels)
      .where(eq(communityChannels.communityId, communityId))
    const position = countRows[0]?.count ?? 0
    await tx.insert(groups).values({
      groupId: channelId,
      kind: 'channel',
      accountA: null,
      accountB: null,
      creatorAccountId: accountId,
    })
    await tx.insert(communityChannels).values({
      channelId,
      communityId,
      name: input.name,
      access: input.access,
      joinDefault: input.joinDefault,
      position,
    })
  })
  await emitToMembers(db, registry, communityId, {
    type: 'community.channel_created',
    payload: {
      communityId: communityId as CommunityId,
      channelId: channelId as GroupId,
      name: input.name,
      access: input.access,
    },
  })
  return { channelId }
}

export async function deleteChannel(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const channel = await db.query.communityChannels.findFirst({
    where: eq(communityChannels.channelId, channelId),
  })
  if (!channel || channel.communityId !== communityId) {
    throw new ServiceError(404, 'channel_not_found')
  }
  await db.transaction(async (tx) => {
    await tx.delete(mlsCursors).where(eq(mlsCursors.groupId, channelId))
    await tx.delete(mlsMessages).where(eq(mlsMessages.groupId, channelId))
    await tx.delete(welcomes).where(eq(welcomes.groupId, channelId))
    await tx.delete(groupMembers).where(eq(groupMembers.groupId, channelId))
    await tx.delete(communityChannels).where(eq(communityChannels.channelId, channelId))
    await tx.delete(groups).where(eq(groups.groupId, channelId))
  })
  await emitToMembers(db, registry, communityId, {
    type: 'community.channel_deleted',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
}

/**
 * Channel MLS bootstrap. Load the channel + its group, assert the caller may
 * act, and return both. Access is enforced by the caller-specific helpers.
 */
async function loadChannel(db: Db, communityId: string, channelId: string) {
  const channel = await db.query.communityChannels.findFirst({
    where: eq(communityChannels.channelId, channelId),
  })
  if (!channel || channel.communityId !== communityId) {
    throw new ServiceError(404, 'channel_not_found')
  }
  const group = await db.query.groups.findFirst({ where: eq(groups.groupId, channelId) })
  if (!group) throw new ServiceError(404, 'channel_not_found')
  return { channel, group }
}

/** Resolve channel + community from the channelId alone (commit/GET paths). */
export async function channelCommunityId(db: Db, channelId: string): Promise<string | null> {
  const channel = await db.query.communityChannels.findFirst({
    where: eq(communityChannels.channelId, channelId),
  })
  return channel?.communityId ?? null
}

export async function publishChannelGroupInfo(
  db: Db,
  accountId: string,
  channelId: string,
  groupInfoB64: string,
  deviceId: string,
): Promise<void> {
  const communityId = await channelCommunityId(db, channelId)
  if (!communityId) throw new ServiceError(404, 'channel_not_found')
  await requireActiveMembership(db, communityId, accountId)
  const { group } = await loadChannel(db, communityId, channelId)
  if (group.creatorAccountId !== accountId) throw new ServiceError(403, 'not_creator')

  const own = await db.query.devices.findFirst({
    where: and(eq(devices.deviceId, deviceId), eq(devices.accountId, accountId)),
  })
  if (!own) throw new ServiceError(400, 'unknown_device')
  if (group.currentEpoch !== 0) throw new ServiceError(409, 'not_epoch_zero')

  const leaves = await db
    .select({ deviceId: groupMembers.deviceId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, channelId))
    .limit(1)
  if (leaves.length > 0) throw new ServiceError(409, 'already_initialized')

  await db.transaction(async (tx) => {
    await tx
      .update(groups)
      .set({ groupInfo: Buffer.from(groupInfoB64, 'base64'), groupInfoEpoch: 0 })
      .where(eq(groups.groupId, channelId))
    await tx.insert(groupMembers).values({
      groupId: channelId,
      deviceId,
      accountId,
      addedEpoch: 0,
    })
  })
}

export async function getChannelJoinInfo(
  db: Db,
  accountId: string,
  channelId: string,
): Promise<ChannelJoinInfoResponse> {
  const communityId = await channelCommunityId(db, channelId)
  if (!communityId) throw new ServiceError(404, 'channel_not_found')
  const membership = await db.query.communityMembers.findFirst({
    where: and(
      eq(communityMembers.communityId, communityId),
      eq(communityMembers.accountId, accountId),
    ),
  })
  const { channel, group } = await loadChannel(db, communityId, channelId)
  if (!satisfiesChannelAccess(membership ?? undefined, channel.access)) {
    throw new ServiceError(403, 'channel_forbidden')
  }
  return {
    channelId: channelId as GroupId,
    groupInfo: group.groupInfo?.toString('base64') ?? null,
    epoch: group.currentEpoch,
    access: channel.access,
  }
}

/* ---------------------------------- roles --------------------------------- */

export async function setMemberRole(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  targetAccountId: string,
  role: 'leader' | 'member',
): Promise<void> {
  const actor = await requireActiveMembership(db, communityId, accountId)
  requireOwner(actor)
  if (targetAccountId === accountId) throw new ServiceError(400, 'cannot_change_own_role')
  const target = await requireActiveMembership(db, communityId, targetAccountId)
  if (target.role === 'owner') throw new ServiceError(400, 'cannot_change_owner')
  if (target.role === role) return

  await db
    .update(communityMembers)
    .set({ role })
    .where(
      and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.accountId, targetAccountId),
      ),
    )
  await emitToMembers(db, registry, communityId, {
    type: 'community.role_changed',
    payload: {
      communityId: communityId as CommunityId,
      accountId: targetAccountId as AccountId,
      role,
    },
  })
}

export async function removeMember(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  targetAccountId: string,
): Promise<void> {
  const actor = await requireActiveMembership(db, communityId, accountId)
  requireLeader(actor)
  if (targetAccountId === accountId) throw new ServiceError(400, 'cannot_remove_self')
  const target = await requireActiveMembership(db, communityId, targetAccountId)
  if (target.role === 'owner') throw new ServiceError(400, 'cannot_remove_owner')
  // Only the owner may remove leaders.
  if (target.role === 'leader' && actor.role !== 'owner') {
    throw new ServiceError(403, 'cannot_remove_leader')
  }

  // Capture recipients before the removal so the removed user is notified too.
  const recipients = await activeMemberAccountIds(db, communityId)
  await db
    .update(communityMembers)
    .set({ status: 'removed', leftAt: new Date() })
    .where(
      and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.accountId, targetAccountId),
      ),
    )
  const message: ServerMessage = {
    type: 'community.member_removed',
    payload: { communityId: communityId as CommunityId, accountId: targetAccountId as AccountId },
  }
  for (const acct of new Set(recipients)) registry.sendToAccount(acct, message)
}

export async function leaveCommunity(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  if (membership.role === 'owner') throw new ServiceError(400, 'owner_cannot_leave')

  const recipients = await activeMemberAccountIds(db, communityId)
  await db
    .update(communityMembers)
    .set({ status: 'left', leftAt: new Date() })
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.accountId, accountId)),
    )
  const message: ServerMessage = {
    type: 'community.member_left',
    payload: { communityId: communityId as CommunityId, accountId: accountId as AccountId },
  }
  for (const acct of new Set(recipients)) registry.sendToAccount(acct, message)
}

/* -------------------------------- pruning --------------------------------- */

/** Housekeeping: delete expired or revoked community invites. */
export async function pruneCommunityInvites(db: Db): Promise<number> {
  const deleted = await db
    .delete(communityInvites)
    .where(
      or(
        lt(communityInvites.expiresAt, new Date()),
        sql`${communityInvites.revokedAt} IS NOT NULL`,
      ),
    )
    .returning({ id: communityInvites.id })
  return deleted.length
}

/* -------------------------------- helpers --------------------------------- */

interface InviteRow {
  id: string
  code: string
  maxUses: number
  useCount: number
  expiresAt: Date
  createdAt: Date
}

function toInviteDto(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt.getTime(),
    createdAt: row.createdAt.getTime(),
  }
}
