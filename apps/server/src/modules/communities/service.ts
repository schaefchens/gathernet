import { randomBytes } from 'node:crypto'
import type {
  AccountId,
  ChannelDevicesResponse,
  ChannelJoinInfoResponse,
  ChannelMemberRole,
  ChannelMyStatus,
  CommunityDetailResponse,
  CommunityDevicesResponse,
  CommunityId,
  CommunityListItem,
  CommunityMembersPageResponse,
  CreateChannelInviteRequest,
  CreateChannelRequest,
  CreateCommunityInviteRequest,
  CreateCommunityRequest,
  DeviceId,
  GroupId,
  MyChannelKeyGrantResponse,
  MyKeyGrantResponse,
  PostChannelKeyGrantsRequest,
  PostKeyGrantsRequest,
  RotateChannelRequest,
  RotateRequest,
  ServerMessage,
  UpdateChannelRequest,
  UpdateCommunityRequest,
} from '@gathernet/shared'
import {
  COMMUNITY_MEDIA_MAX_BYTES,
  COMMUNITY_MEMBER_PAGE_SIZE,
  GROUP_KEY_BROADCAST_MAX_MEMBERS,
  GROUP_KEY_DISCUSSION_MAX_MEMBERS,
  INVITE_CODE_LENGTH,
} from '@gathernet/shared'
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  accounts,
  channelInvites,
  channelKeyEpochs,
  channelKeyGrants,
  channelMembers,
  communities,
  communityChannels,
  communityInvites,
  communityKeyGrants,
  communityMedia,
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
type ChannelRow = typeof communityChannels.$inferSelect
type GroupRow = typeof groups.$inferSelect

const b64 = (buf: Buffer | null): string | null => buf?.toString('base64') ?? null
const bufOf = (b64s: string): Buffer => Buffer.from(b64s, 'base64')

/* ------------------------------- membership ------------------------------- */

/** Active membership row, or 404 (never leak community existence). */
async function requireActiveMembership(
  db: DbOrTx,
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

function isLeaderRole(role: string): boolean {
  return role === 'owner' || role === 'leader'
}

/**
 * Whether an account is an active member of a channel — gates a WS
 * `channel.subscribe` (a subscriber receives that channel's delivery nudges).
 * The nudge carries only `seq` (no ciphertext), and any pull is independently
 * access-controlled, but we verify membership so activity metadata never leaks.
 */
export async function isActiveChannelMember(
  db: DbOrTx,
  channelId: string,
  accountId: string,
): Promise<boolean> {
  const row = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, accountId)),
  })
  return row?.status === 'active'
}

function requireLeader(row: MemberRow): void {
  if (!isLeaderRole(row.role)) throw new ServiceError(403, 'not_a_leader')
}

function requireOwner(row: MemberRow): void {
  if (row.role !== 'owner') throw new ServiceError(403, 'not_owner')
}

/**
 * Community leaders/owner manage every channel; otherwise the caller must be an
 * active *moderator* of the specific channel. Used to gate accept/decline,
 * invite creation, kick, and channel-settings edits.
 */
async function requireChannelManager(
  db: DbOrTx,
  channelId: string,
  membership: MemberRow,
): Promise<void> {
  if (isLeaderRole(membership.role)) return
  const cm = await db.query.channelMembers.findFirst({
    where: and(
      eq(channelMembers.channelId, channelId),
      eq(channelMembers.accountId, membership.accountId),
    ),
  })
  if (cm?.status === 'active' && cm.role === 'moderator') return
  throw new ServiceError(403, 'not_a_moderator')
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

async function leaderAccountIds(db: DbOrTx, communityId: string): Promise<string[]> {
  const rows = await db
    .select({ accountId: communityMembers.accountId, role: communityMembers.role })
    .from(communityMembers)
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, 'active')),
    )
  return rows.filter((r) => isLeaderRole(r.role)).map((r) => r.accountId)
}

async function activeChannelAccountIds(db: DbOrTx, channelId: string): Promise<string[]> {
  const rows = await db
    .select({ accountId: channelMembers.accountId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.status, 'active')))
  return rows.map((r) => r.accountId)
}

/** Recipients for a join request: channel moderators + community leaders/owner. */
async function channelManagerAccountIds(
  db: DbOrTx,
  communityId: string,
  channelId: string,
): Promise<Set<string>> {
  const mods = await db
    .select({ accountId: channelMembers.accountId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.status, 'active'),
        eq(channelMembers.role, 'moderator'),
      ),
    )
  const leaders = await leaderAccountIds(db, communityId)
  return new Set([...mods.map((m) => m.accountId), ...leaders])
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

/**
 * Fan a channel event to those entitled to see channel membership: active
 * channel members + community leaders + any extra accounts (e.g. the affected
 * user, even after they're removed). Unlisted-channel membership never leaks to
 * uninvolved members this way.
 */
async function emitToChannel(
  db: DbOrTx,
  registry: ConnectionRegistry,
  communityId: string,
  channelId: string,
  message: ServerMessage,
  extraAccounts: string[] = [],
): Promise<void> {
  const recipients = new Set([
    ...(await activeChannelAccountIds(db, channelId)),
    ...(await leaderAccountIds(db, communityId)),
    ...extraAccounts,
  ])
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
      metaCiphertext: input.metaCiphertext ? bufOf(input.metaCiphertext) : null,
      avatarMediaId: input.avatarMediaId ?? null,
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
      metaCiphertext: communities.metaCiphertext,
      avatarMediaId: communities.avatarMediaId,
      keyEpoch: communities.keyEpoch,
      rotationPending: communities.rotationPending,
      channelRotationPending: sql<boolean>`EXISTS (
        SELECT 1 FROM community_channels cc
        WHERE cc.community_id = ${communities.communityId}
          AND cc.encryption_mode = 'group_key' AND cc.rotation_pending = true
      )`,
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
    metaCiphertext: b64(r.metaCiphertext),
    avatarMediaId: r.avatarMediaId,
    keyEpoch: r.keyEpoch,
    rotationPending: r.rotationPending,
    channelRotationPending: r.channelRotationPending,
    myRole: r.role,
    channelCount: r.channelCount,
  }))
}

/** Normalize a raw channel_members.status (or absence) to the DTO's view. */
function normalizeStatus(raw: string | null): ChannelMyStatus {
  if (raw === 'active' || raw === 'pending' || raw === 'invited') return raw
  return 'none'
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

  // First page only — a mega-community can have 100k members. The rest are
  // paged via GET …/members. Ordered by accountId so the page boundary is
  // stable and lines up with the paginated endpoint.
  const memberRows = await db
    .select({
      accountId: communityMembers.accountId,
      role: communityMembers.role,
      displayName: accounts.displayName,
    })
    .from(communityMembers)
    .innerJoin(accounts, eq(accounts.accountId, communityMembers.accountId))
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, 'active')),
    )
    .orderBy(asc(communityMembers.accountId))
    .limit(COMMUNITY_MEMBER_PAGE_SIZE)
  const [memberCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(communityMembers)
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, 'active')),
    )

  const isLeader = isLeaderRole(membership.role)
  const channelRows = await db
    .select({
      channelId: communityChannels.channelId,
      metaCiphertext: communityChannels.metaCiphertext,
      avatarMediaId: communityChannels.avatarMediaId,
      access: communityChannels.access,
      visibility: communityChannels.visibility,
      joinPolicy: communityChannels.joinPolicy,
      postPolicy: communityChannels.postPolicy,
      messageTtlDays: communityChannels.messageTtlDays,
      position: communityChannels.position,
      encryptionMode: communityChannels.encryptionMode,
      channelKeyEpoch: communityChannels.keyEpoch,
      channelRotationPending: communityChannels.rotationPending,
      currentEpoch: groups.currentEpoch,
      groupInfo: groups.groupInfo,
      myStatus: channelMembers.status,
      myRole: channelMembers.role,
      myMuted: channelMembers.muted,
      joined: sql<boolean>`EXISTS (
        SELECT 1 FROM group_members gm
        WHERE gm.group_id = ${communityChannels.channelId}
          AND gm.account_id = ${accountId} AND gm.removed_epoch IS NULL
      )`,
      createdAt: communityChannels.createdAt,
    })
    .from(communityChannels)
    .innerJoin(groups, eq(groups.groupId, communityChannels.channelId))
    .leftJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, communityChannels.channelId),
        eq(channelMembers.accountId, accountId),
      ),
    )
    .where(eq(communityChannels.communityId, communityId))
    .orderBy(asc(communityChannels.position), asc(communityChannels.createdAt))

  const channels = channelRows
    .filter((c) => {
      const eligible = c.access === 'members' || isLeader
      const involved = normalizeStatus(c.myStatus) !== 'none'
      // Listed channels are visible to any eligible member; unlisted channels
      // only surface to members who are already involved (active/pending/invited).
      return involved || (c.visibility === 'listed' && eligible)
    })
    .map((c) => {
      const myStatus = normalizeStatus(c.myStatus)
      return {
        channelId: c.channelId as GroupId,
        metaCiphertext: b64(c.metaCiphertext),
        avatarMediaId: c.avatarMediaId,
        access: c.access,
        visibility: c.visibility,
        joinPolicy: c.joinPolicy,
        postPolicy: c.postPolicy,
        messageTtlDays: c.messageTtlDays,
        position: c.position,
        myStatus,
        myRole: (c.myRole ?? 'member') as ChannelMemberRole,
        muted: c.myMuted ?? false,
        joined: c.joined,
        currentEpoch: c.currentEpoch,
        // GroupInfo is released only to active members, and only for mls channels
        // (group_key channels have no MLS group / GroupInfo).
        groupInfo: myStatus === 'active' && c.encryptionMode === 'mls' ? b64(c.groupInfo) : null,
        encryptionMode: c.encryptionMode,
        keyEpoch: c.channelKeyEpoch,
        rotationPending: c.channelRotationPending,
      }
    })

  return {
    community: {
      communityId: community.communityId as CommunityId,
      metaCiphertext: b64(community.metaCiphertext),
      avatarMediaId: community.avatarMediaId,
      keyEpoch: community.keyEpoch,
      rotationPending: community.rotationPending,
      ownerAccountId: community.ownerAccountId as AccountId,
    },
    myRole: membership.role,
    members: memberRows.map((m) => ({
      accountId: m.accountId as AccountId,
      displayName: m.displayName,
      role: m.role,
    })),
    memberCount: memberCountRow?.count ?? memberRows.length,
    channels,
  }
}

/**
 * Paginated active-member roster (any active member may read it, for chat name
 * resolution / member browsing). Ordered by accountId; `after` = last accountId.
 */
export async function listCommunityMembers(
  db: Db,
  accountId: string,
  communityId: string,
  after?: string,
  limit?: number,
): Promise<CommunityMembersPageResponse> {
  await requireActiveMembership(db, communityId, accountId)
  const pageSize = Math.min(limit ?? COMMUNITY_MEMBER_PAGE_SIZE, 500)
  const conds = [
    eq(communityMembers.communityId, communityId),
    eq(communityMembers.status, 'active'),
  ]
  if (after) conds.push(gt(communityMembers.accountId, after))
  const rows = await db
    .select({
      accountId: communityMembers.accountId,
      role: communityMembers.role,
      displayName: accounts.displayName,
    })
    .from(communityMembers)
    .innerJoin(accounts, eq(accounts.accountId, communityMembers.accountId))
    .where(and(...conds))
    .orderBy(asc(communityMembers.accountId))
    .limit(pageSize)
  return {
    members: rows.map((m) => ({
      accountId: m.accountId as AccountId,
      displayName: m.displayName,
      role: m.role,
    })),
    nextCursor: rows.length === pageSize ? (rows[rows.length - 1]?.accountId ?? null) : null,
  }
}

export async function updateCommunity(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  input: UpdateCommunityRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const patch: Partial<typeof communities.$inferInsert> = {}
  if (input.metaCiphertext !== undefined) patch.metaCiphertext = bufOf(input.metaCiphertext)
  if (input.avatarMediaId !== undefined) patch.avatarMediaId = input.avatarMediaId
  await db.update(communities).set(patch).where(eq(communities.communityId, communityId))
  await emitToMembers(db, registry, communityId, {
    type: 'community.updated',
    payload: { communityId: communityId as CommunityId },
  })
}

/* ---------------------------------- media --------------------------------- */

export async function uploadCommunityMedia(
  db: Db,
  accountId: string,
  communityId: string,
  ciphertextB64: string,
): Promise<{ mediaId: string }> {
  await requireActiveMembership(db, communityId, accountId)
  const ciphertext = bufOf(ciphertextB64)
  if (ciphertext.length > COMMUNITY_MEDIA_MAX_BYTES) {
    throw new ServiceError(413, 'media_too_large')
  }
  const mediaId = newHexId('md', 16)
  await db.insert(communityMedia).values({ mediaId, communityId, ciphertext })
  return { mediaId }
}

/** Streams encrypted avatar ciphertext to any active member of its community. */
export async function getCommunityMedia(
  db: Db,
  accountId: string,
  mediaId: string,
): Promise<Buffer> {
  const media = await db.query.communityMedia.findFirst({
    where: eq(communityMedia.mediaId, mediaId),
  })
  if (!media) throw new ServiceError(404, 'media_not_found')
  await requireActiveMembership(db, media.communityId, accountId)
  return media.ciphertext
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
      metaCiphertext: input.metaCiphertext ? bufOf(input.metaCiphertext) : null,
      avatarMediaId: input.avatarMediaId ?? null,
      access: input.access,
      visibility: input.visibility,
      joinPolicy: input.joinPolicy,
      postPolicy: input.postPolicy,
      messageTtlDays: input.messageTtlDays,
      encryptionMode: input.encryptionMode,
      position,
    })
    // The creator is the channel's first active member and its first moderator.
    await tx.insert(channelMembers).values({
      channelId,
      accountId,
      status: 'active',
      role: 'moderator',
    })
  })
  await emitToMembers(db, registry, communityId, {
    type: 'community.channel_created',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
  return { channelId }
}

async function loadChannel(
  db: DbOrTx,
  communityId: string,
  channelId: string,
): Promise<ChannelRow> {
  const channel = await db.query.communityChannels.findFirst({
    where: eq(communityChannels.channelId, channelId),
  })
  if (!channel || channel.communityId !== communityId) {
    throw new ServiceError(404, 'channel_not_found')
  }
  return channel
}

async function loadGroup(db: DbOrTx, channelId: string): Promise<GroupRow> {
  const group = await db.query.groups.findFirst({ where: eq(groups.groupId, channelId) })
  if (!group) throw new ServiceError(404, 'channel_not_found')
  return group
}

export async function updateChannel(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  input: UpdateChannelRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  const patch: Partial<typeof communityChannels.$inferInsert> = {}
  if (input.metaCiphertext !== undefined) patch.metaCiphertext = bufOf(input.metaCiphertext)
  if (input.avatarMediaId !== undefined) patch.avatarMediaId = input.avatarMediaId
  if (input.access !== undefined) patch.access = input.access
  if (input.visibility !== undefined) patch.visibility = input.visibility
  if (input.joinPolicy !== undefined) patch.joinPolicy = input.joinPolicy
  if (input.postPolicy !== undefined) patch.postPolicy = input.postPolicy
  if (input.messageTtlDays !== undefined) patch.messageTtlDays = input.messageTtlDays
  if (input.position !== undefined) patch.position = input.position
  await db.update(communityChannels).set(patch).where(eq(communityChannels.channelId, channelId))
  await emitToMembers(db, registry, communityId, {
    type: 'community.channel_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
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
  await loadChannel(db, communityId, channelId)
  await db.transaction(async (tx) => {
    await tx.delete(mlsCursors).where(eq(mlsCursors.groupId, channelId))
    await tx.delete(mlsMessages).where(eq(mlsMessages.groupId, channelId))
    await tx.delete(welcomes).where(eq(welcomes.groupId, channelId))
    await tx.delete(groupMembers).where(eq(groupMembers.groupId, channelId))
    await tx.delete(channelInvites).where(eq(channelInvites.channelId, channelId))
    await tx.delete(channelMembers).where(eq(channelMembers.channelId, channelId))
    await tx.delete(communityChannels).where(eq(communityChannels.channelId, channelId))
    await tx.delete(groups).where(eq(groups.groupId, channelId))
  })
  await emitToMembers(db, registry, communityId, {
    type: 'community.channel_deleted',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
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
  const group = await loadGroup(db, channelId)
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
      .set({ groupInfo: bufOf(groupInfoB64), groupInfoEpoch: 0 })
      .where(eq(groups.groupId, channelId))
    await tx.insert(groupMembers).values({
      groupId: channelId,
      deviceId,
      accountId,
      addedEpoch: 0,
    })
  })
}

function joinInfo(
  channelId: string,
  status: ChannelMyStatus,
  channel: Pick<ChannelRow, 'access' | 'encryptionMode' | 'keyEpoch' | 'communityId'>,
  group: GroupRow,
): ChannelJoinInfoResponse {
  return {
    channelId: channelId as GroupId,
    communityId: channel.communityId as CommunityId,
    status,
    access: channel.access,
    // mls: GroupInfo released only to active members. group_key: no MLS group.
    groupInfo:
      status === 'active' && channel.encryptionMode === 'mls' ? b64(group.groupInfo) : null,
    epoch: group.currentEpoch,
    encryptionMode: channel.encryptionMode,
    keyEpoch: channel.keyEpoch,
  }
}

/** Upsert an active channel membership (preserving an existing channel role). */
async function activateChannelMember(
  db: DbOrTx,
  channelId: string,
  accountId: string,
  invitedBy?: string,
): Promise<void> {
  await db
    .insert(channelMembers)
    .values({
      channelId,
      accountId,
      status: 'active',
      role: 'member',
      invitedBy: invitedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [channelMembers.channelId, channelMembers.accountId],
      set: { status: 'active' },
    })
}

/**
 * Enforce the membership ceiling for group_key channels before activating a NEW
 * member. mls channels are bounded by the device cap in postCommit instead;
 * this is a no-op for them. Broadcast (moderators-post) tolerates many more
 * readers than discussion (everyone-post). Best-effort under races — the caps
 * are soft ceilings, not a security boundary.
 */
async function enforceGroupKeyMemberCap(db: DbOrTx, channel: ChannelRow): Promise<void> {
  if (channel.encryptionMode !== 'group_key') return
  const cap =
    channel.postPolicy === 'moderators'
      ? GROUP_KEY_BROADCAST_MAX_MEMBERS
      : GROUP_KEY_DISCUSSION_MAX_MEMBERS
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelMembers)
    .where(
      and(eq(channelMembers.channelId, channel.channelId), eq(channelMembers.status, 'active')),
    )
  if ((row?.count ?? 0) >= cap) throw new ServiceError(409, 'channel_full')
}

/**
 * Self-service join of a channel by an active community member. Behaviour by
 * the caller's current channel state and the channel's policy:
 *   - already active → idempotent, returns join keys.
 *   - already pending → idempotent, stays pending.
 *   - invited (targeted) → accepts the invite, becomes active.
 *   - otherwise (none/removed) → listed+open ⇒ active; listed+request ⇒ pending
 *     (notifies moderators); unlisted ⇒ 404 (reachable only by code/invite).
 */
export async function joinChannel(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
): Promise<ChannelJoinInfoResponse> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  const group = await loadGroup(db, channelId)
  const eligible = satisfiesChannelAccess(membership, channel.access)

  const existing = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, accountId)),
  })

  if (existing?.status === 'active') return joinInfo(channelId, 'active', channel, group)
  if (existing?.status === 'pending') return joinInfo(channelId, 'pending', channel, group)

  if (existing?.status === 'invited') {
    if (!eligible) throw new ServiceError(403, 'channel_forbidden')
    await enforceGroupKeyMemberCap(db, channel)
    await activateChannelMember(db, channelId, accountId)
    await announceChannelMember(db, registry, communityId, channelId, accountId, 'active', 'member')
    return joinInfo(channelId, 'active', channel, group)
  }

  // Fresh join (no row, or a previously-removed row).
  if (!eligible) throw new ServiceError(403, 'channel_forbidden')
  if (channel.visibility === 'unlisted') throw new ServiceError(404, 'channel_not_found')

  if (channel.joinPolicy === 'open') {
    await enforceGroupKeyMemberCap(db, channel)
    await activateChannelMember(db, channelId, accountId)
    await announceChannelMember(db, registry, communityId, channelId, accountId, 'active', 'member')
    return joinInfo(channelId, 'active', channel, group)
  }

  // request policy → pending, notify managers.
  await db
    .insert(channelMembers)
    .values({ channelId, accountId, status: 'pending', role: 'member' })
    .onConflictDoUpdate({
      target: [channelMembers.channelId, channelMembers.accountId],
      set: { status: 'pending', role: 'member' },
    })
  const displayName = await displayNameOf(db, accountId)
  const managers = await channelManagerAccountIds(db, communityId, channelId)
  const message: ServerMessage = {
    type: 'community.channel_join_request',
    payload: {
      communityId: communityId as CommunityId,
      channelId: channelId as GroupId,
      accountId: accountId as AccountId,
      displayName,
    },
  }
  for (const acct of managers) registry.sendToAccount(acct, message)
  return joinInfo(channelId, 'pending', channel, group)
}

/** Join an unlisted (or listed) channel via a per-channel invite code. */
export async function joinChannelByCode(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  code: string,
): Promise<ChannelJoinInfoResponse> {
  const { channel, group, wasPending } = await db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(channelInvites)
      .where(and(eq(channelInvites.code, code), eq(channelInvites.kind, 'code')))
      .for('update')
    if (
      !invite ||
      invite.revokedAt !== null ||
      invite.expiresAt <= new Date() ||
      invite.useCount >= invite.maxUses
    ) {
      throw new ServiceError(404, 'invite_invalid')
    }
    const channel = await loadChannel(tx, communityId, invite.channelId)
    const membership = await requireActiveMembership(tx, communityId, accountId)
    if (!satisfiesChannelAccess(membership, channel.access)) {
      throw new ServiceError(403, 'channel_forbidden')
    }
    const group = await loadGroup(tx, channel.channelId)
    const existing = await tx.query.channelMembers.findFirst({
      where: and(
        eq(channelMembers.channelId, channel.channelId),
        eq(channelMembers.accountId, accountId),
      ),
    })
    if (existing?.status === 'active' || existing?.status === 'pending') {
      return { channel, group, wasPending: existing.status === 'pending' }
    }
    // Code respects the channel's join policy.
    if (channel.joinPolicy === 'open') {
      await enforceGroupKeyMemberCap(tx, channel)
      await activateChannelMember(tx, channel.channelId, accountId)
    } else {
      await tx
        .insert(channelMembers)
        .values({ channelId: channel.channelId, accountId, status: 'pending', role: 'member' })
        .onConflictDoUpdate({
          target: [channelMembers.channelId, channelMembers.accountId],
          set: { status: 'pending', role: 'member' },
        })
    }
    await tx
      .update(channelInvites)
      .set({ useCount: sql`${channelInvites.useCount} + 1` })
      .where(eq(channelInvites.id, invite.id))
    return { channel, group, wasPending: channel.joinPolicy === 'request' }
  })

  if (wasPending) {
    const displayName = await displayNameOf(db, accountId)
    const managers = await channelManagerAccountIds(db, communityId, channel.channelId)
    const message: ServerMessage = {
      type: 'community.channel_join_request',
      payload: {
        communityId: communityId as CommunityId,
        channelId: channel.channelId as GroupId,
        accountId: accountId as AccountId,
        displayName,
      },
    }
    for (const acct of managers) registry.sendToAccount(acct, message)
    return joinInfo(channel.channelId, 'pending', channel, group)
  }
  await announceChannelMember(
    db,
    registry,
    communityId,
    channel.channelId,
    accountId,
    'active',
    'member',
  )
  return joinInfo(channel.channelId, 'active', channel, group)
}

/** Moderator/leader accepts or declines a pending join request. */
export async function resolveJoinRequest(
  db: Db,
  registry: ConnectionRegistry,
  actorAccountId: string,
  communityId: string,
  channelId: string,
  targetAccountId: string,
  action: 'accept' | 'decline',
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, actorAccountId)
  const channel = await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)

  const target = await db.query.channelMembers.findFirst({
    where: and(
      eq(channelMembers.channelId, channelId),
      eq(channelMembers.accountId, targetAccountId),
    ),
  })
  if (target?.status !== 'pending') throw new ServiceError(404, 'request_not_found')

  if (action === 'decline') {
    await db
      .update(channelMembers)
      .set({ status: 'removed' })
      .where(
        and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, targetAccountId)),
      )
    registry.sendToAccount(targetAccountId, {
      type: 'community.channel_join_declined',
      payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
    })
    return
  }

  await enforceGroupKeyMemberCap(db, channel)
  await activateChannelMember(db, channelId, targetAccountId)
  const group = await loadGroup(db, channelId)
  registry.sendToAccount(targetAccountId, {
    type: 'community.channel_join_approved',
    payload: {
      communityId: communityId as CommunityId,
      channelId: channelId as GroupId,
      groupInfo: b64(group.groupInfo),
      epoch: group.currentEpoch,
    },
  })
  await announceChannelMember(
    db,
    registry,
    communityId,
    channelId,
    targetAccountId,
    'active',
    'member',
  )
}

/** Moderator/leader creates a targeted invite (for a member) or a code invite. */
export async function createChannelInvite(
  db: Db,
  registry: ConnectionRegistry,
  actorAccountId: string,
  communityId: string,
  channelId: string,
  input: CreateChannelInviteRequest,
): Promise<{ code: string | null }> {
  const membership = await requireActiveMembership(db, communityId, actorAccountId)
  const channel = await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)

  if (input.kind === 'targeted') {
    const target = await requireActiveMembership(db, communityId, input.inviteeAccountId)
    if (!satisfiesChannelAccess(target, channel.access)) {
      throw new ServiceError(400, 'invitee_not_eligible')
    }
    const existing = await db.query.channelMembers.findFirst({
      where: and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.accountId, input.inviteeAccountId),
      ),
    })
    if (existing?.status === 'active') throw new ServiceError(409, 'already_member')
    await db
      .insert(channelMembers)
      .values({
        channelId,
        accountId: input.inviteeAccountId,
        status: 'invited',
        role: 'member',
        invitedBy: actorAccountId,
      })
      .onConflictDoUpdate({
        target: [channelMembers.channelId, channelMembers.accountId],
        set: { status: 'invited', invitedBy: actorAccountId },
      })
    await db.insert(channelInvites).values({
      channelId,
      kind: 'targeted',
      inviteeAccountId: input.inviteeAccountId,
      createdBy: actorAccountId,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    })
    registry.sendToAccount(input.inviteeAccountId, {
      type: 'community.channel_invited',
      payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
    })
    return { code: null }
  }

  const code = newCrockfordCode(INVITE_CODE_LENGTH)
  await db.insert(channelInvites).values({
    channelId,
    kind: 'code',
    code,
    createdBy: actorAccountId,
    maxUses: input.maxUses,
    expiresAt: new Date(Date.now() + input.ttlHours * 3600 * 1000),
  })
  return { code }
}

/** Leader/owner appoints or removes a channel moderator (target must be active). */
export async function setModerator(
  db: Db,
  registry: ConnectionRegistry,
  actorAccountId: string,
  communityId: string,
  channelId: string,
  targetAccountId: string,
  action: 'set' | 'unset',
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, actorAccountId)
  requireLeader(membership)
  await loadChannel(db, communityId, channelId)
  const target = await db.query.channelMembers.findFirst({
    where: and(
      eq(channelMembers.channelId, channelId),
      eq(channelMembers.accountId, targetAccountId),
    ),
  })
  if (target?.status !== 'active') throw new ServiceError(404, 'not_a_channel_member')
  const role: ChannelMemberRole = action === 'set' ? 'moderator' : 'member'
  await db
    .update(channelMembers)
    .set({ role })
    .where(
      and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, targetAccountId)),
    )
  await announceChannelMember(db, registry, communityId, channelId, targetAccountId, 'active', role)
}

/**
 * Moderator/leader mutes or unmutes an active member in a channel. A muted
 * member keeps read access but is refused posting (enforced in delivery's
 * `postMessage`, regardless of the channel's postPolicy).
 */
export async function setMuted(
  db: Db,
  registry: ConnectionRegistry,
  actorAccountId: string,
  communityId: string,
  channelId: string,
  targetAccountId: string,
  muted: boolean,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, actorAccountId)
  await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  if (targetAccountId === actorAccountId) throw new ServiceError(400, 'cannot_mute_self')

  const target = await db.query.channelMembers.findFirst({
    where: and(
      eq(channelMembers.channelId, channelId),
      eq(channelMembers.accountId, targetAccountId),
    ),
  })
  if (target?.status !== 'active') throw new ServiceError(404, 'not_a_channel_member')

  // A plain-member moderator cannot mute a community leader/owner.
  if (!isLeaderRole(membership.role)) {
    const targetCommunity = await db.query.communityMembers.findFirst({
      where: and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.accountId, targetAccountId),
      ),
    })
    if (targetCommunity && isLeaderRole(targetCommunity.role)) {
      throw new ServiceError(403, 'cannot_mute_leader')
    }
  }

  await db
    .update(channelMembers)
    .set({ muted })
    .where(
      and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, targetAccountId)),
    )
  await announceChannelMember(
    db,
    registry,
    communityId,
    channelId,
    targetAccountId,
    'active',
    target.role,
    [targetAccountId],
  )
}

/**
 * Moderator/leader removes a member from a channel (not the community). The
 * acting client follows up with an MLS removeMembers commit to evict the
 * target's device leaves; the server marks the account removed and notifies.
 */
export async function kickFromChannel(
  db: Db,
  registry: ConnectionRegistry,
  actorAccountId: string,
  communityId: string,
  channelId: string,
  targetAccountId: string,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, actorAccountId)
  await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  if (targetAccountId === actorAccountId) throw new ServiceError(400, 'cannot_kick_self')

  const target = await db.query.channelMembers.findFirst({
    where: and(
      eq(channelMembers.channelId, channelId),
      eq(channelMembers.accountId, targetAccountId),
    ),
  })
  if (!target || target.status === 'removed') throw new ServiceError(404, 'not_a_channel_member')

  // A plain-member moderator cannot kick a community leader/owner from a channel.
  if (!isLeaderRole(membership.role)) {
    const targetCommunity = await db.query.communityMembers.findFirst({
      where: and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.accountId, targetAccountId),
      ),
    })
    if (targetCommunity && isLeaderRole(targetCommunity.role)) {
      throw new ServiceError(403, 'cannot_kick_leader')
    }
  }

  await db
    .update(channelMembers)
    .set({ status: 'removed', role: 'member' })
    .where(
      and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, targetAccountId)),
    )
  await announceChannelMember(
    db,
    registry,
    communityId,
    channelId,
    targetAccountId,
    'none',
    'member',
    [targetAccountId],
  )
  // group_key channel: the kicked member held K_channel — rotate it stale.
  const channel = await loadChannel(db, communityId, channelId)
  if (channel.encryptionMode === 'group_key') {
    await requestChannelRotation(db, registry, communityId, channelId)
  }
}

/** Broadcast a channel membership change to those entitled to see it. */
async function announceChannelMember(
  db: DbOrTx,
  registry: ConnectionRegistry,
  communityId: string,
  channelId: string,
  accountId: string,
  status: ChannelMyStatus,
  role: ChannelMemberRole,
  extra: string[] = [],
): Promise<void> {
  await emitToChannel(
    db,
    registry,
    communityId,
    channelId,
    {
      type: 'community.channel_member_changed',
      payload: {
        communityId: communityId as CommunityId,
        channelId: channelId as GroupId,
        accountId: accountId as AccountId,
        status,
        role,
      },
    },
    extra,
  )
}

/** Manager-only channel roster: active members, pending requests, invitees. */
export async function listChannelMembers(
  db: Db,
  actorAccountId: string,
  communityId: string,
  channelId: string,
  after?: string,
  limit?: number,
): Promise<{
  members: Array<{
    accountId: string
    displayName: string
    status: string
    role: string
    muted: boolean
  }>
  nextCursor: string | null
}> {
  const membership = await requireActiveMembership(db, communityId, actorAccountId)
  await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  const pageSize = Math.min(limit ?? COMMUNITY_MEMBER_PAGE_SIZE, 500)
  const conds = [
    eq(channelMembers.channelId, channelId),
    inArray(channelMembers.status, ['active', 'pending', 'invited']),
  ]
  if (after) conds.push(gt(channelMembers.accountId, after))
  const rows = await db
    .select({
      accountId: channelMembers.accountId,
      status: channelMembers.status,
      role: channelMembers.role,
      muted: channelMembers.muted,
      displayName: accounts.displayName,
    })
    .from(channelMembers)
    .innerJoin(accounts, eq(accounts.accountId, channelMembers.accountId))
    .where(and(...conds))
    .orderBy(asc(channelMembers.accountId))
    .limit(pageSize)
  return {
    members: rows,
    nextCursor: rows.length === pageSize ? (rows[rows.length - 1]?.accountId ?? null) : null,
  }
}

export async function getChannelJoinInfo(
  db: Db,
  accountId: string,
  channelId: string,
): Promise<ChannelJoinInfoResponse> {
  const communityId = await channelCommunityId(db, channelId)
  if (!communityId) throw new ServiceError(404, 'channel_not_found')
  const membership = await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  const group = await loadGroup(db, channelId)

  const row = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, accountId)),
  })
  const status = normalizeStatus(row?.status ?? null)
  if (status === 'active') return joinInfo(channelId, 'active', channel, group)
  if (status === 'pending' || status === 'invited') {
    return joinInfo(channelId, status, channel, group)
  }
  // Not involved: only eligible members may see a channel exists at all.
  if (!satisfiesChannelAccess(membership, channel.access)) {
    throw new ServiceError(403, 'channel_forbidden')
  }
  return joinInfo(channelId, 'none', channel, group)
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

/**
 * Clear a member's channel memberships across a community (community exit).
 * Returns the group_key channels the member was ACTIVE in, flagged for
 * rotation — a removed member's cached K_channel must go stale (a manager's
 * client rotates). mls channels rotate via the client's own removeMembers commit.
 */
async function clearChannelMemberships(
  db: DbOrTx,
  communityId: string,
  accountId: string,
): Promise<string[]> {
  const channelIds = await db
    .select({ channelId: communityChannels.channelId })
    .from(communityChannels)
    .where(eq(communityChannels.communityId, communityId))
  if (channelIds.length === 0) return []
  const activeGroupKey = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(communityChannels, eq(communityChannels.channelId, channelMembers.channelId))
    .where(
      and(
        eq(channelMembers.accountId, accountId),
        eq(channelMembers.status, 'active'),
        eq(communityChannels.communityId, communityId),
        eq(communityChannels.encryptionMode, 'group_key'),
      ),
    )
  await db
    .update(channelMembers)
    .set({ status: 'removed', role: 'member' })
    .where(
      and(
        inArray(
          channelMembers.channelId,
          channelIds.map((c) => c.channelId),
        ),
        eq(channelMembers.accountId, accountId),
      ),
    )
  const gkIds = activeGroupKey.map((r) => r.channelId)
  if (gkIds.length > 0) {
    await db
      .update(communityChannels)
      .set({ rotationPending: true })
      .where(inArray(communityChannels.channelId, gkIds))
  }
  return gkIds
}

/**
 * Flag a group_key channel for K_channel rotation and nudge its managers. The
 * server can't rotate (never sees K_channel) — a manager's client mints the new
 * epoch. Durable flag + WS nudge, mirroring requestRotation for K_meta.
 */
async function requestChannelRotation(
  db: DbOrTx,
  registry: ConnectionRegistry,
  communityId: string,
  channelId: string,
): Promise<void> {
  await db
    .update(communityChannels)
    .set({ rotationPending: true })
    .where(eq(communityChannels.channelId, channelId))
  for (const acct of await channelManagerAccountIds(db, communityId, channelId)) {
    registry.sendToAccount(acct, {
      type: 'community.channel_rotation_needed',
      payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
    })
  }
}

/** Nudge managers of the given (already-flagged) group_key channels to rotate. */
async function notifyChannelRotations(
  db: DbOrTx,
  registry: ConnectionRegistry,
  communityId: string,
  channelIds: string[],
): Promise<void> {
  for (const channelId of channelIds) {
    for (const acct of await channelManagerAccountIds(db, communityId, channelId)) {
      registry.sendToAccount(acct, {
        type: 'community.channel_rotation_needed',
        payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
      })
    }
  }
}

/**
 * Flag the community for K_meta rotation and nudge remaining leaders. The
 * server can't rotate (it never sees K_meta) — a leader's client does the
 * re-encryption via `rotateCommunity`. The flag makes it durable: a leader that
 * missed the WS event rotates the next time it opens the community.
 */
async function requestRotation(
  db: Db,
  registry: ConnectionRegistry,
  communityId: string,
): Promise<void> {
  await db
    .update(communities)
    .set({ rotationPending: true })
    .where(eq(communities.communityId, communityId))
  for (const acct of await leaderAccountIds(db, communityId)) {
    registry.sendToAccount(acct, {
      type: 'community.rotation_needed',
      payload: { communityId: communityId as CommunityId },
    })
  }
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
  const gkChannels = await db.transaction(async (tx) => {
    await tx
      .update(communityMembers)
      .set({ status: 'removed', leftAt: new Date() })
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.accountId, targetAccountId),
        ),
      )
    return clearChannelMemberships(tx, communityId, targetAccountId)
  })
  const message: ServerMessage = {
    type: 'community.member_removed',
    payload: { communityId: communityId as CommunityId, accountId: targetAccountId as AccountId },
  }
  for (const acct of new Set(recipients)) registry.sendToAccount(acct, message)
  // The removed member held K_meta — rotate it so their cached copy goes stale.
  await requestRotation(db, registry, communityId)
  // ...and K_channel for every group_key channel they were in.
  await notifyChannelRotations(db, registry, communityId, gkChannels)
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
  const gkChannels = await db.transaction(async (tx) => {
    await tx
      .update(communityMembers)
      .set({ status: 'left', leftAt: new Date() })
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.accountId, accountId),
        ),
      )
    return clearChannelMemberships(tx, communityId, accountId)
  })
  const message: ServerMessage = {
    type: 'community.member_left',
    payload: { communityId: communityId as CommunityId, accountId: accountId as AccountId },
  }
  for (const acct of new Set(recipients)) registry.sendToAccount(acct, message)
  // The departing member held K_meta — rotate it.
  await requestRotation(db, registry, communityId)
  // ...and K_channel for every group_key channel they were in.
  await notifyChannelRotations(db, registry, communityId, gkChannels)
}

/* --------------------- K_meta cross-device key grants --------------------- */

/** Active-member active devices of a community that can receive a K_meta grant. */
async function grantableDeviceRows(
  db: DbOrTx,
  communityId: string,
  page?: { after?: string; limit: number },
) {
  const conds = [
    eq(communityMembers.communityId, communityId),
    eq(communityMembers.status, 'active'),
    eq(devices.status, 'active'),
  ]
  if (page?.after) conds.push(gt(devices.deviceId, page.after))
  const q = db
    .select({
      accountId: devices.accountId,
      deviceId: devices.deviceId,
      cert: devices.cert,
      certSig: devices.certSig,
      receiptPk: devices.receiptPk,
      receiptPkSig: devices.receiptPkSig,
    })
    .from(communityMembers)
    .innerJoin(devices, eq(devices.accountId, communityMembers.accountId))
    .where(and(...conds))
  // Paginated (grant fan-out) vs full list (grantee validation in postKeyGrants).
  if (page) return q.orderBy(asc(devices.deviceId)).limit(page.limit)
  return q
}

/**
 * The active-member devices a grant may be sealed to. The caller authenticates
 * each `receiptPk` itself (cert signature under the member identity, then
 * `receiptPkSig` under the cert's device key) — the server is not trusted for it.
 */
export async function listCommunityDevices(
  db: Db,
  accountId: string,
  communityId: string,
  after?: string,
  limit?: number,
): Promise<CommunityDevicesResponse> {
  await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  const pageSize = Math.min(limit ?? 500, 500)
  const rows = await grantableDeviceRows(db, communityId, {
    ...(after ? { after } : {}),
    limit: pageSize,
  })
  const list: CommunityDevicesResponse['devices'] = []
  for (const r of rows) {
    if (!r.receiptPk || !r.receiptPkSig) continue // device predates the feature
    list.push({
      accountId: r.accountId as AccountId,
      deviceId: r.deviceId as DeviceId,
      deviceCert: r.cert.toString('base64'),
      certSig: r.certSig.toString('base64'),
      receiptPk: r.receiptPk.toString('base64'),
      receiptPkSig: r.receiptPkSig.toString('base64'),
    })
  }
  // Cursor advances by the raw device page (some rows may be filtered above).
  const nextCursor = rows.length === pageSize ? (rows[rows.length - 1]?.deviceId ?? null) : null
  return { keyEpoch: community.keyEpoch, devices: list, nextCursor }
}

/** Store K_meta grants (ciphertext only) for active-member devices. Idempotent. */
export async function postKeyGrants(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  keyEpoch: number,
  grants: PostKeyGrantsRequest['grants'],
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  if (keyEpoch !== community.keyEpoch) throw new ServiceError(409, 'key_epoch_stale')

  // Only seal to devices that actually belong to active members — never leak
  // K_meta to an outsider's device.
  const allowed = new Set((await grantableDeviceRows(db, communityId)).map((r) => r.deviceId))
  for (const g of grants) {
    if (!allowed.has(g.granteeDeviceId)) throw new ServiceError(400, 'invalid_grantee')
  }

  await db
    .insert(communityKeyGrants)
    .values(
      grants.map((g) => ({
        communityId,
        keyEpoch,
        granteeDeviceId: g.granteeDeviceId,
        sealedKMeta: bufOf(g.sealedKMeta),
        senderPkB64: g.senderPkB64,
        createdBy: accountId,
      })),
    )
    .onConflictDoNothing()

  const owners = await db
    .select({ accountId: devices.accountId })
    .from(devices)
    .where(
      inArray(
        devices.deviceId,
        grants.map((g) => g.granteeDeviceId),
      ),
    )
  for (const acct of new Set(owners.map((o) => o.accountId))) {
    registry.sendToAccount(acct, {
      type: 'community.key_grants_available',
      payload: { communityId: communityId as CommunityId },
    })
  }
}

/** The grant sealed to the caller's current device at the community's key epoch. */
export async function myKeyGrant(
  db: Db,
  accountId: string,
  deviceId: string,
  communityId: string,
): Promise<MyKeyGrantResponse> {
  await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  const row = await db.query.communityKeyGrants.findFirst({
    where: and(
      eq(communityKeyGrants.communityId, communityId),
      eq(communityKeyGrants.keyEpoch, community.keyEpoch),
      eq(communityKeyGrants.granteeDeviceId, deviceId),
    ),
  })
  return {
    keyEpoch: community.keyEpoch,
    grant: row
      ? { sealedKMeta: row.sealedKMeta.toString('base64'), senderPkB64: row.senderPkB64 }
      : null,
  }
}

/**
 * Apply a leader-driven K_meta rotation atomically. All metadata + media are
 * re-encrypted client-side under a new key; the server bumps the epoch with a
 * compare-and-set (concurrent rotations lose → 409), swaps in the ciphertext,
 * drops stale grants, and installs the new-epoch grants for remaining devices.
 * The server never sees K_meta.
 */
export async function rotateCommunity(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  input: RotateRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const newEpoch = input.fromEpoch + 1

  const granteeAccounts = await db.transaction(async (tx) => {
    // Compare-and-set the epoch: only one rotation from `fromEpoch` wins.
    const bumped = await tx
      .update(communities)
      .set({
        keyEpoch: newEpoch,
        rotationPending: false,
        metaCiphertext: input.community.metaCiphertext
          ? bufOf(input.community.metaCiphertext)
          : null,
      })
      .where(
        and(eq(communities.communityId, communityId), eq(communities.keyEpoch, input.fromEpoch)),
      )
      .returning({ id: communities.communityId })
    if (bumped.length === 0) throw new ServiceError(409, 'rotation_stale')

    for (const ch of input.channels) {
      await tx
        .update(communityChannels)
        .set({ metaCiphertext: ch.metaCiphertext ? bufOf(ch.metaCiphertext) : null })
        .where(
          and(
            eq(communityChannels.channelId, ch.channelId),
            eq(communityChannels.communityId, communityId),
          ),
        )
    }
    for (const m of input.media) {
      await tx
        .update(communityMedia)
        .set({ ciphertext: bufOf(m.ciphertext) })
        .where(
          and(eq(communityMedia.mediaId, m.mediaId), eq(communityMedia.communityId, communityId)),
        )
    }

    // Old-epoch grants (incl. any to the removed member) become useless — drop them.
    await tx
      .delete(communityKeyGrants)
      .where(
        and(
          eq(communityKeyGrants.communityId, communityId),
          lt(communityKeyGrants.keyEpoch, newEpoch),
        ),
      )

    // Install new grants, but only for devices of still-active members.
    const allowed = new Set((await grantableDeviceRows(tx, communityId)).map((r) => r.deviceId))
    for (const g of input.grants) {
      if (!allowed.has(g.granteeDeviceId)) throw new ServiceError(400, 'invalid_grantee')
    }
    if (input.grants.length > 0) {
      await tx
        .insert(communityKeyGrants)
        .values(
          input.grants.map((g) => ({
            communityId,
            keyEpoch: newEpoch,
            granteeDeviceId: g.granteeDeviceId,
            sealedKMeta: bufOf(g.sealedKMeta),
            senderPkB64: g.senderPkB64,
            createdBy: accountId,
          })),
        )
        .onConflictDoNothing()
    }

    const owners = await tx
      .select({ accountId: devices.accountId })
      .from(devices)
      .where(
        inArray(
          devices.deviceId,
          input.grants.map((g) => g.granteeDeviceId),
        ),
      )
    return new Set(owners.map((o) => o.accountId))
  })

  // Members refetch metadata (new epoch); grantees' other devices fetch the key.
  await emitToMembers(db, registry, communityId, {
    type: 'community.updated',
    payload: { communityId: communityId as CommunityId },
  })
  for (const acct of granteeAccounts) {
    registry.sendToAccount(acct, {
      type: 'community.key_grants_available',
      payload: { communityId: communityId as CommunityId },
    })
  }
}

/* --------------------- K_channel (group_key) grants ----------------------- */

/** Active devices of a channel's active members (grant fan-out), optionally paged. */
async function grantableChannelDeviceRows(
  db: DbOrTx,
  channelId: string,
  page?: { after?: string; limit: number },
) {
  const conds = [
    eq(channelMembers.channelId, channelId),
    eq(channelMembers.status, 'active'),
    eq(devices.status, 'active'),
  ]
  if (page?.after) conds.push(gt(devices.deviceId, page.after))
  const q = db
    .select({
      accountId: devices.accountId,
      deviceId: devices.deviceId,
      cert: devices.cert,
      certSig: devices.certSig,
      receiptPk: devices.receiptPk,
      receiptPkSig: devices.receiptPkSig,
    })
    .from(channelMembers)
    .innerJoin(devices, eq(devices.accountId, channelMembers.accountId))
    .where(and(...conds))
  if (page) return q.orderBy(asc(devices.deviceId)).limit(page.limit)
  return q
}

/** Assert `deviceId` belongs to `accountId` (the minter binds its own device). */
async function requireOwnDevice(db: DbOrTx, accountId: string, deviceId: string): Promise<void> {
  const dev = await db.query.devices.findFirst({
    where: and(eq(devices.deviceId, deviceId), eq(devices.accountId, accountId)),
  })
  if (!dev) throw new ServiceError(400, 'invalid_minter')
}

/**
 * Devices a K_channel grant may be sealed to = the channel's active-member
 * devices. Manager-only (the bounded granter set) — this also keeps a plain
 * member from enumerating a 100k-device list. Paginated for grant fan-out.
 */
export async function listChannelDevices(
  db: Db,
  accountId: string,
  communityId: string,
  channelId: string,
  after?: string,
  limit?: number,
): Promise<ChannelDevicesResponse> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  const pageSize = Math.min(limit ?? 500, 500)
  const rows = await grantableChannelDeviceRows(db, channelId, {
    ...(after ? { after } : {}),
    limit: pageSize,
  })
  const list: ChannelDevicesResponse['devices'] = []
  for (const r of rows) {
    if (!r.receiptPk || !r.receiptPkSig) continue
    list.push({
      accountId: r.accountId as AccountId,
      deviceId: r.deviceId as DeviceId,
      deviceCert: r.cert.toString('base64'),
      certSig: r.certSig.toString('base64'),
      receiptPk: r.receiptPk.toString('base64'),
      receiptPkSig: r.receiptPkSig.toString('base64'),
    })
  }
  const nextCursor = rows.length === pageSize ? (rows[rows.length - 1]?.deviceId ?? null) : null
  return { keyEpoch: channel.keyEpoch, devices: list, nextCursor }
}

/**
 * Store K_channel grants (ciphertext only) sealed to active-member devices.
 * Manager-only. Idempotent. The optional epoch `commitment` (authenticated
 * minter signature over SHA256(channelId‖epoch‖K_channel)) is upserted once per
 * epoch so grantees can detect a partition (two keys for one epoch).
 */
export async function postChannelKeyGrants(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  input: PostChannelKeyGrantsRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  if (channel.encryptionMode !== 'group_key') throw new ServiceError(400, 'not_group_key')
  if (input.keyEpoch !== channel.keyEpoch) throw new ServiceError(409, 'key_epoch_stale')

  // Only seal to devices of active channel members — never leak K_channel.
  const allowed = new Set((await grantableChannelDeviceRows(db, channelId)).map((r) => r.deviceId))
  for (const g of input.grants) {
    if (!allowed.has(g.granteeDeviceId)) throw new ServiceError(400, 'invalid_grantee')
  }

  await db.transaction(async (tx) => {
    if (input.commitment) {
      await requireOwnDevice(tx, accountId, input.commitment.minterDeviceId)
      await tx
        .insert(channelKeyEpochs)
        .values({
          channelId,
          keyEpoch: input.keyEpoch,
          keyCommitment: bufOf(input.commitment.keyCommitment),
          minterDeviceId: input.commitment.minterDeviceId,
          minterSig: bufOf(input.commitment.minterSig),
        })
        .onConflictDoNothing()
    }
    await tx
      .insert(channelKeyGrants)
      .values(
        input.grants.map((g) => ({
          channelId,
          keyEpoch: input.keyEpoch,
          granteeDeviceId: g.granteeDeviceId,
          sealedKey: bufOf(g.sealedKey),
          senderPkB64: g.senderPkB64,
          createdBy: accountId,
        })),
      )
      .onConflictDoNothing()
  })

  await notifyChannelGrantees(db, registry, communityId, channelId, input.grants)
}

/** The K_channel grant + epoch commitment for the caller's device at the current epoch. */
export async function myChannelKeyGrant(
  db: Db,
  accountId: string,
  deviceId: string,
  communityId: string,
  channelId: string,
): Promise<MyChannelKeyGrantResponse> {
  await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  // Only an active channel member may fetch the key (a removed member is denied).
  const chanMem = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, accountId)),
  })
  if (chanMem?.status !== 'active') throw new ServiceError(403, 'not_a_member')

  const row = await db.query.channelKeyGrants.findFirst({
    where: and(
      eq(channelKeyGrants.channelId, channelId),
      eq(channelKeyGrants.keyEpoch, channel.keyEpoch),
      eq(channelKeyGrants.granteeDeviceId, deviceId),
    ),
  })
  const commit = await db.query.channelKeyEpochs.findFirst({
    where: and(
      eq(channelKeyEpochs.channelId, channelId),
      eq(channelKeyEpochs.keyEpoch, channel.keyEpoch),
    ),
  })
  return {
    keyEpoch: channel.keyEpoch,
    grant: row
      ? { sealedKey: row.sealedKey.toString('base64'), senderPkB64: row.senderPkB64 }
      : null,
    commitment: commit
      ? {
          keyCommitment: commit.keyCommitment.toString('base64'),
          minterDeviceId: commit.minterDeviceId as DeviceId,
          minterSig: commit.minterSig.toString('base64'),
        }
      : null,
  }
}

/**
 * Rotate a group_key channel to a fresh K_channel epoch (member removed/left, or
 * periodic PCS refresh). Manager-only. Unlike K_meta rotation, messages are NOT
 * re-encrypted — old messages stay under their old epoch and expire by TTL, so
 * OLD-epoch grants are KEPT (a still-active device restoring history needs them;
 * a removed member is denied by access control). A compare-and-set on the
 * channel `keyEpoch` serialises concurrent rotations.
 */
export async function rotateChannel(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  input: RotateChannelRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  if (channel.encryptionMode !== 'group_key') throw new ServiceError(400, 'not_group_key')
  const newEpoch = input.fromEpoch + 1

  await db.transaction(async (tx) => {
    const bumped = await tx
      .update(communityChannels)
      .set({ keyEpoch: newEpoch, rotationPending: false })
      .where(
        and(
          eq(communityChannels.channelId, channelId),
          eq(communityChannels.keyEpoch, input.fromEpoch),
        ),
      )
      .returning({ id: communityChannels.channelId })
    if (bumped.length === 0) throw new ServiceError(409, 'rotation_stale')

    await requireOwnDevice(tx, accountId, input.commitment.minterDeviceId)
    await tx
      .insert(channelKeyEpochs)
      .values({
        channelId,
        keyEpoch: newEpoch,
        keyCommitment: bufOf(input.commitment.keyCommitment),
        minterDeviceId: input.commitment.minterDeviceId,
        minterSig: bufOf(input.commitment.minterSig),
      })
      .onConflictDoNothing()

    // New-epoch grants — only for devices of still-active members (never the removed one).
    const allowed = new Set(
      (await grantableChannelDeviceRows(tx, channelId)).map((r) => r.deviceId),
    )
    for (const g of input.grants) {
      if (!allowed.has(g.granteeDeviceId)) throw new ServiceError(400, 'invalid_grantee')
    }
    if (input.grants.length > 0) {
      await tx
        .insert(channelKeyGrants)
        .values(
          input.grants.map((g) => ({
            channelId,
            keyEpoch: newEpoch,
            granteeDeviceId: g.granteeDeviceId,
            sealedKey: bufOf(g.sealedKey),
            senderPkB64: g.senderPkB64,
            createdBy: accountId,
          })),
        )
        .onConflictDoNothing()
    }
  })

  await notifyChannelGrantees(db, registry, communityId, channelId, input.grants)
}

/** Nudge grantee accounts that a K_channel grant is waiting for one of their devices. */
async function notifyChannelGrantees(
  db: DbOrTx,
  registry: ConnectionRegistry,
  communityId: string,
  channelId: string,
  grants: Array<{ granteeDeviceId: string }>,
): Promise<void> {
  if (grants.length === 0) return
  const owners = await db
    .select({ accountId: devices.accountId })
    .from(devices)
    .where(
      inArray(
        devices.deviceId,
        grants.map((g) => g.granteeDeviceId),
      ),
    )
  for (const acct of new Set(owners.map((o) => o.accountId))) {
    registry.sendToAccount(acct, {
      type: 'community.channel_key_grants_available',
      payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
    })
  }
}

/* -------------------------------- pruning --------------------------------- */

/**
 * Housekeeping: drop K_channel grants + epoch commitments for old epochs whose
 * messages have all expired (per-channel TTL). Kept while any message at that
 * epoch survives so a restoring device can still read un-expired history.
 */
export async function pruneChannelKeyGrants(db: Db): Promise<number> {
  const grantsDeleted = await db.execute(sql`
    DELETE FROM channel_key_grants g
    USING community_channels cc
    WHERE g.channel_id = cc.channel_id
      AND g.key_epoch < cc.key_epoch
      AND NOT EXISTS (
        SELECT 1 FROM mls_messages m WHERE m.group_id = g.channel_id AND m.epoch = g.key_epoch
      )
  `)
  await db.execute(sql`
    DELETE FROM channel_key_epochs e
    USING community_channels cc
    WHERE e.channel_id = cc.channel_id
      AND e.key_epoch < cc.key_epoch
      AND NOT EXISTS (
        SELECT 1 FROM channel_key_grants g
        WHERE g.channel_id = e.channel_id AND g.key_epoch = e.key_epoch
      )
  `)
  return grantsDeleted.rowCount ?? 0
}

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

/** Housekeeping: delete expired or revoked channel invites. */
export async function pruneChannelInvites(db: Db): Promise<number> {
  const deleted = await db
    .delete(channelInvites)
    .where(
      or(lt(channelInvites.expiresAt, new Date()), sql`${channelInvites.revokedAt} IS NOT NULL`),
    )
    .returning({ id: channelInvites.id })
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
