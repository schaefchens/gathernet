import { createHash, randomBytes } from 'node:crypto'
import type {
  AccountId,
  ApproveArtifactRequest,
  ArtifactParticipant,
  CapabilityResponse,
  ChannelArtifact,
  ChannelDevicesResponse,
  ChannelJoinInfoResponse,
  ChannelMemberRole,
  ChannelMyStatus,
  CommunityDetailResponse,
  CommunityDevice,
  CommunityDevicesResponse,
  CommunityId,
  CommunityListItem,
  CommunityMemberIdsPageResponse,
  CommunityMembersPageResponse,
  CreateChannelInviteRequest,
  CreateChannelRequest,
  CreateCommunityInviteRequest,
  CreateCommunityRequest,
  DeleteTicketRequest,
  DeviceId,
  GroupId,
  ListArtifactsResponse,
  ListReportsResponse,
  MembershipCapability,
  ModerationRecipientsResponse,
  MyCapabilitiesResponse,
  MyChannelKeyGrantResponse,
  MyKeyGrantResponse,
  PostArtifactRequest,
  PostCapabilitiesRequest,
  PostChannelKeyGrantsRequest,
  PostKeyGrantsRequest,
  PostParticipationRequest,
  PostReportRequest,
  PostTicketRequest,
  ReminderTriggerRequest,
  ResolveReportRequest,
  RollcallSweepResponse,
  RotateChannelRequest,
  RotateRequest,
  ServerMessage,
  StartRollcallRequest,
  UpdateChannelRequest,
  UpdateCommunityRequest,
} from '@gathernet/shared'
import {
  bucketMemberCount,
  COMMUNITY_MEDIA_MAX_BYTES,
  COMMUNITY_MEMBER_PAGE_SIZE,
  GROUP_KEY_BROADCAST_MAX_MEMBERS,
  GROUP_KEY_DISCUSSION_MAX_MEMBERS,
  INVITE_CODE_LENGTH,
  SMALL_GROUP_MAX_MEMBERS,
} from '@gathernet/shared'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import {
  accounts,
  channelArtifactParticipants,
  channelArtifacts,
  channelArtifactTickets,
  channelInvites,
  channelKeyEpochs,
  channelKeyGrants,
  channelMembers,
  channelReminderFires,
  channelReportRecipients,
  channelReports,
  communities,
  communityChannels,
  communityInvites,
  communityKeyEpochs,
  communityKeyGrants,
  communityMedia,
  communityMembers,
  devices,
  groupMembers,
  groups,
  membershipCapabilities,
  mlsCursors,
  mlsMessages,
  welcomes,
} from '../../db/schema.ts'
import { newCrockfordCode, newHexId } from '../../lib/codes.ts'
import type { BlobStore } from '../../storage/blob-store.ts'
import type { ConnectionRegistry } from '../../ws/registry.ts'
import { ServiceError } from '../accounts/service.ts'
import { satisfiesChannelAccess } from '../delivery/service.ts'
import { notifyEventReminder, notifyOfflineManagers } from '../push/service.ts'

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

/**
 * Whether an account may see this community's ROSTER: community leaders/owner, or a
 * moderator of any channel in it (they need it to invite + moderate). Casual members never
 * enumerate a community's people — they see only the "active members" their own decrypted
 * channel history reveals. @see listCommunityMembers
 */
async function isCommunityManager(
  db: DbOrTx,
  communityId: string,
  membership: MemberRow,
): Promise<boolean> {
  if (isLeaderRole(membership.role)) return true
  const mod = await db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(communityChannels, eq(communityChannels.channelId, channelMembers.channelId))
    .where(
      and(
        eq(communityChannels.communityId, communityId),
        eq(channelMembers.accountId, membership.accountId),
        eq(channelMembers.status, 'active'),
        eq(channelMembers.role, 'moderator'),
      ),
    )
    .limit(1)
  return mod.length > 0
}

async function activeMemberCount(db: DbOrTx, communityId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(communityMembers)
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, 'active')),
    )
  return row?.count ?? 0
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

/**
 * Store the owner-signed community root (capability-chain anchor). Owner-only, and
 * the signing device must belong to the owner account. The server relays this
 * client-produced signature — it never mints it. Idempotent (owner may re-post).
 */
export async function setCommunityRoot(
  db: Db,
  accountId: string,
  communityId: string,
  ownerDeviceId: string,
  ownerSig: string,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireOwner(membership)
  await requireOwnDevice(db, accountId, ownerDeviceId)
  await db
    .update(communities)
    .set({ rootDeviceId: ownerDeviceId, rootSig: bufOf(ownerSig) })
    .where(eq(communities.communityId, communityId))
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

  // Roster: MANAGERS ONLY (see listCommunityMembers). Casual members get an empty list and
  // derive "active members" from their own visible channel history instead. First page only
  // — a mega-community can have 100k members; the rest are paged via GET …/members. Ordered
  // by accountId so the page boundary is stable and lines up with that endpoint.
  const canSeeRoster = await isCommunityManager(db, communityId, membership)
  const memberRows = canSeeRoster
    ? await db
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
    : []
  const [memberCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(communityMembers)
    .where(
      and(eq(communityMembers.communityId, communityId), eq(communityMembers.status, 'active')),
    )
  const activeCount = memberCountRow?.count ?? memberRows.length

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
      pinPolicy: communityChannels.pinPolicy,
      memberListVisibility: communityChannels.memberListVisibility,
      maxDevicesPerMember: communityChannels.maxDevicesPerMember,
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
        pinPolicy: c.pinPolicy,
        memberListVisibility: c.memberListVisibility,
        maxDevicesPerMember: c.maxDevicesPerMember,
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
      maxDevicesPerMember: community.maxDevicesPerMember,
      ownerAccountId: community.ownerAccountId as AccountId,
      root:
        community.rootDeviceId && community.rootSig
          ? {
              communityId: community.communityId as CommunityId,
              ownerAccountId: community.ownerAccountId as AccountId,
              ownerDeviceId: community.rootDeviceId as DeviceId,
              ownerSig: community.rootSig.toString('base64'),
            }
          : null,
    },
    myRole: membership.role,
    members: memberRows.map((m) => ({
      accountId: m.accountId as AccountId,
      displayName: m.displayName,
      role: m.role,
    })),
    // Exact only for small communities; larger ones report a coarse band so no exact head
    // count of a congregation ever leaves the server.
    memberCount: activeCount <= SMALL_GROUP_MAX_MEMBERS ? activeCount : null,
    memberBucket: bucketMemberCount(activeCount),
    channels,
  }
}

/**
 * Paginated active-member roster — MANAGERS ONLY (leaders/owner, or a moderator of some
 * channel here). Casual members must never enumerate a community's people; their client
 * derives "active members" from the senders in their own decrypted channel history, and
 * message bubbles are labelled from the sender name carried inside the sealed body.
 * Ordered by accountId; `after` = last accountId.
 */
export async function listCommunityMembers(
  db: Db,
  accountId: string,
  communityId: string,
  after?: string,
  limit?: number,
): Promise<CommunityMembersPageResponse> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  // MANAGERS ONLY. Wholesale enumeration of a community's people is not a member-level
  // capability — see isCommunityManager + the no-roster rule.
  if (!(await isCommunityManager(db, communityId, membership))) {
    throw new ServiceError(403, 'not_a_manager')
  }
  // ...and only for a SMALL community: a scrollable name list for a mega-community is
  // useless to a human and a deanonymization risk if that manager is compromised/coerced.
  // Capability issuance uses listCommunityMemberIds (no display names) instead.
  if ((await activeMemberCount(db, communityId)) > SMALL_GROUP_MAX_MEMBERS) {
    throw new ServiceError(403, 'roster_too_large')
  }
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

/**
 * Member IDENTITIES (accountId + role, NO display names) — owner/leader only, available at
 * ANY community size. This is what capability issuance (ADR 0004) sweeps: a leader must mint
 * a cap per member even in a 100k community, and doing it from ids means minting never
 * materialises a browsable roster. @see listCommunityMembers for the human-browsable list.
 */
export async function listCommunityMemberIds(
  db: Db,
  accountId: string,
  communityId: string,
  after?: string,
  limit?: number,
): Promise<CommunityMemberIdsPageResponse> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  requireLeader(membership)
  const pageSize = Math.min(limit ?? COMMUNITY_MEMBER_PAGE_SIZE, 500)
  const conds = [
    eq(communityMembers.communityId, communityId),
    eq(communityMembers.status, 'active'),
  ]
  if (after) conds.push(gt(communityMembers.accountId, after))
  const rows = await db
    .select({ accountId: communityMembers.accountId, role: communityMembers.role })
    .from(communityMembers)
    .where(and(...conds))
    .orderBy(asc(communityMembers.accountId))
    .limit(pageSize)
  return {
    members: rows.map((m) => ({ accountId: m.accountId as AccountId, role: m.role })),
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
  if (input.maxDevicesPerMember !== undefined) {
    patch.maxDevicesPerMember = input.maxDevicesPerMember
  }
  await db.update(communities).set(patch).where(eq(communities.communityId, communityId))
  await emitToMembers(db, registry, communityId, {
    type: 'community.updated',
    payload: { communityId: communityId as CommunityId },
  })
}

/* ---------------------------------- media --------------------------------- */

/** Object key for a community media blob (avatar ciphertext). */
export const communityBlobKey = (mediaId: string) => `community/${mediaId}`

export async function uploadCommunityMedia(
  db: Db,
  blob: BlobStore,
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
  // Ciphertext → object storage; the row is metadata + the community binding.
  await blob.put(communityBlobKey(mediaId), ciphertext, 'application/octet-stream')
  await db.insert(communityMedia).values({ mediaId, communityId })
  return { mediaId }
}

/** Streams encrypted avatar ciphertext (from object storage) to any active member. */
export async function getCommunityMedia(
  db: Db,
  blob: BlobStore,
  accountId: string,
  mediaId: string,
): Promise<Buffer> {
  const media = await db.query.communityMedia.findFirst({
    where: eq(communityMedia.mediaId, mediaId),
  })
  if (!media) throw new ServiceError(404, 'media_not_found')
  await requireActiveMembership(db, media.communityId, accountId)
  const bytes = await blob.get(communityBlobKey(mediaId))
  if (!bytes) throw new ServiceError(404, 'media_not_found')
  return bytes
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
      // Default the pin policy from the encryption mode: small MLS channels let
      // everyone pin; big group_key channels default to suggest→approve.
      pinPolicy:
        input.pinPolicy ?? (input.encryptionMode === 'group_key' ? 'moderators' : 'everyone'),
      memberListVisibility: input.memberListVisibility,
      maxDevicesPerMember: input.maxDevicesPerMember,
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
  if (input.pinPolicy !== undefined) patch.pinPolicy = input.pinPolicy
  if (input.memberListVisibility !== undefined) {
    patch.memberListVisibility = input.memberListVisibility
  }
  if (input.maxDevicesPerMember !== undefined) {
    patch.maxDevicesPerMember = input.maxDevicesPerMember
  }
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
  // Offline-fallback push to managers who need to accept/decline.
  void notifyOfflineManagers(db, managers, communityId, (a) => registry.isAccountOnline(a))
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
  if (action === 'unset') {
    // Immediate revocation: delete the demoted account's channel-scope capability
    // now (the relay serves caps, so honest deletion drops authority at once) —
    // closing the pre-rotation window where the demoted moderator could still mint a
    // trusted rotation. Belt-and-suspenders: also request a K_meta rotation so the
    // epoch bump invalidates it even for clients that cached the cap.
    await db
      .delete(membershipCapabilities)
      .where(
        and(
          eq(membershipCapabilities.communityId, communityId),
          eq(membershipCapabilities.scope, channelId),
          eq(membershipCapabilities.subjectAccountId, targetAccountId),
        ),
      )
    await requestRotation(db, registry, communityId)
  }
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
  // group_key channel: the kicked member held K_channel — rotate it stale, and
  // drop their delivery subscription so they stop seeing post activity.
  const channel = await loadChannel(db, communityId, channelId)
  if (channel.encryptionMode === 'group_key') {
    registry.evictAccountFromChannel(targetAccountId, channelId)
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
  const channel = await loadChannel(db, communityId, channelId)
  // Managers always; plain members only when a manager opted this SMALL (mls) channel into
  // memberListVisibility 'members' AND they're an active member of it. A group_key channel
  // is a big/broadcast channel by definition — it never exposes a roster to members,
  // whatever the setting says. Otherwise the no-roster rule stands and their client shows
  // "active members" derived from local history.
  const memberVisible =
    channel.memberListVisibility === 'members' && channel.encryptionMode === 'mls'
  if (!(memberVisible && (await isActiveChannelMember(db, channelId, actorAccountId)))) {
    await requireChannelManager(db, channelId, membership)
  }
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
  // Demotion (leader→member) must invalidate the demoted account's still-valid
  // leader capability. Caps are pinned to community.keyEpoch and the cap PK blocks
  // same-epoch supersession, so revocation must ride an epoch bump: request a K_meta
  // rotation. A leader's client re-issues caps at the new epoch WITHOUT the demoted
  // leader's, and its stale old-epoch cap fails the freshness pin.
  if (role === 'member') await requestRotation(db, registry, communityId)
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
  // ...and K_channel for every group_key channel they were in; drop their subs.
  for (const channelId of gkChannels) registry.evictAccountFromChannel(targetAccountId, channelId)
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
  // ...and K_channel for every group_key channel they were in; drop their subs.
  for (const channelId of gkChannels) registry.evictAccountFromChannel(accountId, channelId)
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

/**
 * A single active-member device by id (its cert) — lets a capability verifier
 * resolve a cap's issuer device regardless of which page of a 100k-device roster
 * it falls on, without enumerating the whole list. Active-member gated; returns
 * null for an unknown/inactive device (the caller bounds how many it fetches).
 */
export async function getCommunityDevice(
  db: Db,
  accountId: string,
  communityId: string,
  deviceId: string,
): Promise<{ device: CommunityDevice | null }> {
  await requireActiveMembership(db, communityId, accountId)
  const rows = await db
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
    .where(
      and(
        eq(communityMembers.communityId, communityId),
        eq(communityMembers.status, 'active'),
        eq(devices.status, 'active'),
        eq(devices.deviceId, deviceId),
      ),
    )
    .limit(1)
  const r = rows[0]
  if (!r) return { device: null }
  // Return the DeviceCert even when the device has no receipt key: cert-based
  // signature verification (capabilities, pinned artifacts, sender auth) needs only
  // the cert. A device without a receipt key simply can't be a grant recipient
  // (receiptPk = null), which the grant paths handle by skipping it.
  return {
    device: {
      accountId: r.accountId as AccountId,
      deviceId: r.deviceId as DeviceId,
      deviceCert: r.cert.toString('base64'),
      certSig: r.certSig.toString('base64'),
      receiptPk: r.receiptPk ? r.receiptPk.toString('base64') : null,
      receiptPkSig: r.receiptPkSig ? r.receiptPkSig.toString('base64') : null,
    },
  }
}

/** Store K_meta grants (ciphertext only) for active-member devices. Idempotent. */
export async function postKeyGrants(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  input: PostKeyGrantsRequest,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  if (input.keyEpoch !== community.keyEpoch) throw new ServiceError(409, 'key_epoch_stale')

  // Only seal to devices that actually belong to active members — never leak
  // K_meta to an outsider's device.
  const allowed = new Set((await grantableDeviceRows(db, communityId)).map((r) => r.deviceId))
  for (const g of input.grants) {
    if (!allowed.has(g.granteeDeviceId)) throw new ServiceError(400, 'invalid_grantee')
  }

  await db.transaction(async (tx) => {
    // The authenticated epoch commitment binds K_meta to community+epoch (fetchers
    // verify their opened key against it). Published once per epoch with the grants.
    if (input.commitment) {
      await requireOwnDevice(tx, accountId, input.commitment.minterDeviceId)
      await tx
        .insert(communityKeyEpochs)
        .values({
          communityId,
          keyEpoch: input.keyEpoch,
          keyCommitment: bufOf(input.commitment.keyCommitment),
          minterDeviceId: input.commitment.minterDeviceId,
          minterSig: bufOf(input.commitment.minterSig),
        })
        .onConflictDoNothing()
    }
    await tx
      .insert(communityKeyGrants)
      .values(
        input.grants.map((g) => ({
          communityId,
          keyEpoch: input.keyEpoch,
          granteeDeviceId: g.granteeDeviceId,
          sealedKMeta: bufOf(g.sealedKMeta),
          senderPkB64: g.senderPkB64,
          createdBy: accountId,
        })),
      )
      .onConflictDoNothing()
  })

  const owners = await db
    .select({ accountId: devices.accountId })
    .from(devices)
    .where(
      inArray(
        devices.deviceId,
        input.grants.map((g) => g.granteeDeviceId),
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
  const commit = await db.query.communityKeyEpochs.findFirst({
    where: and(
      eq(communityKeyEpochs.communityId, communityId),
      eq(communityKeyEpochs.keyEpoch, community.keyEpoch),
    ),
  })
  return {
    keyEpoch: community.keyEpoch,
    grant: row
      ? { sealedKMeta: row.sealedKMeta.toString('base64'), senderPkB64: row.senderPkB64 }
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

/* --------------------------- membership capabilities --------------------------- */

const toCapability = (r: {
  communityId: string
  scope: string
  subjectAccountId: string
  role: string
  epoch: number
  issuerDeviceId: string
  issuerSig: Buffer
}): MembershipCapability => ({
  communityId: r.communityId as CommunityId,
  scope: r.scope,
  subjectAccountId: r.subjectAccountId as AccountId,
  role: r.role as MembershipCapability['role'],
  epoch: r.epoch,
  issuerDeviceId: r.issuerDeviceId as DeviceId,
  issuerSig: r.issuerSig.toString('base64'),
})

/**
 * Store issuer-minted membership capabilities. The server is a pure relay — it
 * never mints or validates the Ed25519 chain (clients do, against the pinned
 * owner root); it only accepts caps from an active member and pins them to the
 * community's *current* epoch, so a stale-epoch cap can't be back-filled. The
 * `(communityId, scope, subjectAccountId, epoch)` PK makes re-issue idempotent.
 */
export async function postCapabilities(
  db: Db,
  accountId: string,
  communityId: string,
  input: PostCapabilitiesRequest,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  const rows = input.capabilities
    .filter((c) => c.communityId === communityId && c.epoch === community.keyEpoch)
    .map((c) => ({
      communityId,
      scope: c.scope,
      subjectAccountId: c.subjectAccountId,
      epoch: c.epoch,
      role: c.role,
      issuerDeviceId: c.issuerDeviceId,
      issuerSig: bufOf(c.issuerSig),
      createdBy: accountId,
    }))
  if (rows.length === 0) return
  await db.insert(membershipCapabilities).values(rows).onConflictDoNothing()
}

/** The caller's own capabilities at the community's current epoch (proves own membership). */
export async function myCapabilities(
  db: Db,
  accountId: string,
  communityId: string,
): Promise<MyCapabilitiesResponse> {
  await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  const rows = await db
    .select()
    .from(membershipCapabilities)
    .where(
      and(
        eq(membershipCapabilities.communityId, communityId),
        eq(membershipCapabilities.subjectAccountId, accountId),
        eq(membershipCapabilities.epoch, community.keyEpoch),
      ),
    )
  return { epoch: community.keyEpoch, capabilities: rows.map(toCapability) }
}

/**
 * A specific account's capability at a scope + the community's current epoch —
 * so a verifier can walk the delegation chain (a member cap's issuer → that
 * issuer's leader cap). Any active member may read caps (signed attestations,
 * not secrets).
 */
export async function getCapability(
  db: Db,
  accountId: string,
  communityId: string,
  scope: string,
  subjectAccountId: string,
): Promise<CapabilityResponse> {
  await requireActiveMembership(db, communityId, accountId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  const row = await db.query.membershipCapabilities.findFirst({
    where: and(
      eq(membershipCapabilities.communityId, communityId),
      eq(membershipCapabilities.scope, scope),
      eq(membershipCapabilities.subjectAccountId, subjectAccountId),
      eq(membershipCapabilities.epoch, community.keyEpoch),
    ),
  })
  return { capability: row ? toCapability(row) : null }
}

/* ------------------- pinned channel artifacts (relayed) ------------------- */

type ArtifactRow = typeof channelArtifacts.$inferSelect

function toArtifact(
  r: ArtifactRow,
  ticketCount = 0,
  responders: string[] = [],
  managerView = false,
  callerAccountId?: string,
): ChannelArtifact {
  return {
    artifactId: r.artifactId,
    channelId: r.channelId as GroupId,
    kind: r.kind,
    sealEpoch: r.sealEpoch,
    sealedBody: r.sealedBody.toString('base64'),
    issuerDeviceId: r.issuerDeviceId as DeviceId,
    issuerSig: r.issuerSig.toString('base64'),
    approverDeviceId: (r.approverDeviceId as DeviceId | null) ?? null,
    approvalSig: b64(r.approvalSig),
    createdBy: r.createdBy as AccountId,
    createdAt: r.createdAt.getTime(),
    expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
    ticketCount,
    responseCount: responders.length,
    respondedByMe: !!callerAccountId && responders.includes(callerAccountId),
    responders: managerView ? (responders as ChannelArtifact['responders']) : [],
  }
}

/**
 * Store an author-minted pinned artifact. The server is a pure relay — it never
 * reads or validates the sealed body or the signature (clients verify `issuerSig`
 * against the capability chain + the channel's pinPolicy). Any active member may
 * post (a member's record is a *suggestion* until a manager approves it, which
 * honest clients enforce). The body must be sealed under the community's current
 * K_meta epoch so a late joiner can read it; a stale epoch is refused.
 */
export async function postArtifact(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  input: PostArtifactRequest,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (!community) throw new ServiceError(404, 'community_not_found')
  // The body must be sealed under a K_meta epoch the community has actually reached —
  // a future epoch is bogus. A member whose held epoch lags the server is still
  // accepted (they can only seal under the key they hold); rotation re-seals forward.
  if (input.sealEpoch > community.keyEpoch) throw new ServiceError(409, 'key_epoch_stale')
  // The signer's device must be one of the poster's own devices.
  await requireOwnDevice(db, accountId, input.issuerDeviceId)
  await db
    .insert(channelArtifacts)
    .values({
      artifactId: input.artifactId,
      channelId,
      communityId,
      kind: input.kind,
      sealEpoch: input.sealEpoch,
      sealedBody: bufOf(input.sealedBody),
      issuerDeviceId: input.issuerDeviceId,
      issuerSig: bufOf(input.issuerSig),
      createdBy: accountId,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    })
    .onConflictDoNothing()
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
  // Under moderators policy, a non-manager's artifact is a suggestion awaiting approval
  // (the authoritative check is client-side; this uses server-asserted roles to decide
  // whether to nudge managers) → push offline managers. Cheap approximation, low stakes.
  if (channel.pinPolicy === 'moderators') {
    const managers = await channelManagerAccountIds(db, communityId, channelId)
    if (!managers.has(accountId)) {
      void notifyOfflineManagers(db, managers, communityId, (a) => registry.isAccountOnline(a))
    }
  }
}

/** Active (non-expired) pinned artifacts for a channel — visible to any active member. */
export async function listArtifacts(
  db: Db,
  accountId: string,
  communityId: string,
  channelId: string,
): Promise<ListArtifactsResponse> {
  await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  const now = new Date()
  const rows = await db
    .select()
    .from(channelArtifacts)
    .where(
      and(
        eq(channelArtifacts.channelId, channelId),
        or(isNull(channelArtifacts.expiresAt), gt(channelArtifacts.expiresAt, now)),
      ),
    )
    .orderBy(asc(channelArtifacts.createdAt))
  // Anonymous RSVP: only COUNTS ever leave the server — no identities exist to leak, and
  // ticket values are bearer capabilities that must never be handed to other members.
  const ticketRows = await db
    .select({
      artifactId: channelArtifactTickets.artifactId,
      count: sql<number>`count(*)::int`,
    })
    .from(channelArtifactTickets)
    .where(eq(channelArtifactTickets.channelId, channelId))
    .groupBy(channelArtifactTickets.artifactId)
  const ticketsByArtifact = new Map(ticketRows.map((t) => [t.artifactId, t.count]))
  // Roll-call responses are IDENTIFIED. Everyone sees the count; only a manager sees WHO
  // responded (they need it to compute the sweep) — members never get a name list.
  const membership = await requireActiveMembership(db, communityId, accountId)
  const isManager = await isCommunityManager(db, communityId, membership)
  const respRows = await db
    .select({
      artifactId: channelArtifactParticipants.artifactId,
      accountId: channelArtifactParticipants.accountId,
    })
    .from(channelArtifactParticipants)
    .where(eq(channelArtifactParticipants.channelId, channelId))
  const respByArtifact = new Map<string, string[]>()
  for (const r of respRows) {
    const list = respByArtifact.get(r.artifactId) ?? []
    list.push(r.accountId)
    respByArtifact.set(r.artifactId, list)
  }
  return {
    artifacts: rows.map((r) =>
      toArtifact(
        r,
        ticketsByArtifact.get(r.artifactId) ?? 0,
        respByArtifact.get(r.artifactId) ?? [],
        isManager,
        accountId,
      ),
    ),
  }
}

/**
 * RSVP anonymously: store SHA-256(ticket) with NO accountId, so "who is coming" is never a
 * stored fact. Idempotent on the hash. Bounded by the channel's active member count so a
 * single member can't inflate a headcount without limit (counts stay APPROXIMATE by design —
 * nothing links a ticket to a person, which is the point).
 */
export async function postTicket(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
  input: PostTicketRequest,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  const artifact = await db.query.channelArtifacts.findFirst({
    where: and(
      eq(channelArtifacts.artifactId, artifactId),
      eq(channelArtifacts.channelId, channelId),
    ),
  })
  if (!artifact) throw new ServiceError(404, 'artifact_not_found')
  // Sanity bound: never more tickets than there are people who could hold one.
  const [tickets] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelArtifactTickets)
    .where(eq(channelArtifactTickets.artifactId, artifactId))
  const [members] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.status, 'active')))
  if ((tickets?.count ?? 0) >= (members?.count ?? 0)) {
    throw new ServiceError(409, 'ticket_limit')
  }
  await db
    .insert(channelArtifactTickets)
    .values({ artifactId, channelId, ticketHash: input.ticketHash })
    .onConflictDoNothing()
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
}

/** Withdraw an anonymous RSVP by presenting the ticket PREIMAGE (knowledge = authority). */
export async function deleteTicket(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
  input: DeleteTicketRequest,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  const ticketHash = createHash('sha256').update(input.ticket, 'utf8').digest('hex')
  await db
    .delete(channelArtifactTickets)
    .where(
      and(
        eq(channelArtifactTickets.artifactId, artifactId),
        eq(channelArtifactTickets.ticketHash, ticketHash),
      ),
    )
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
}

/** Withdraw the caller's own participation. */
export async function deleteParticipation(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  await db
    .delete(channelArtifactParticipants)
    .where(
      and(
        eq(channelArtifactParticipants.artifactId, artifactId),
        eq(channelArtifactParticipants.accountId, accountId),
      ),
    )
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
}

/* ----------------------- message reports (E2EE, mod-only) ----------------------- */

/**
 * The channel's mod/leader devices a report may be sealed to — a small role-defined set
 * (NOT a browsable roster, honouring the no-roster rule for mega channels). A reporter's
 * client ECIES-seals the report to every device here; each device's cert/receiptPk is
 * authenticated client-side (the server is never trusted for it). Any active community
 * member may fetch it, so a plain member can file a report.
 */
export async function listModerationRecipients(
  db: Db,
  accountId: string,
  communityId: string,
  channelId: string,
): Promise<ModerationRecipientsResponse> {
  await requireActiveMembership(db, communityId, accountId)
  const managers = await channelManagerAccountIds(db, communityId, channelId)
  if (managers.size === 0) return { devices: [] }
  const rows = await db
    .select({
      accountId: devices.accountId,
      deviceId: devices.deviceId,
      cert: devices.cert,
      certSig: devices.certSig,
      receiptPk: devices.receiptPk,
      receiptPkSig: devices.receiptPkSig,
    })
    .from(devices)
    .where(
      and(
        inArray(devices.accountId, [...managers]),
        eq(devices.status, 'active'),
        isNotNull(devices.receiptPk),
      ),
    )
  const list: ModerationRecipientsResponse['devices'] = rows.map((r) => ({
    accountId: r.accountId as AccountId,
    deviceId: r.deviceId as DeviceId,
    deviceCert: r.cert.toString('base64'),
    certSig: r.certSig.toString('base64'),
    receiptPk: r.receiptPk?.toString('base64') ?? null,
    receiptPkSig: r.receiptPkSig?.toString('base64') ?? null,
  }))
  return { devices: list }
}

/**
 * File a message report: one lifecycle row (server-visible routing metadata only) plus a
 * per-moderator ECIES envelope of the identical sealed plaintext. The server stores opaque
 * blobs — it never sees the reported content, author, or reason. Idempotent on reportId.
 * Notifies the channel's managers so their client refetches the review queue.
 */
export async function postReport(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  input: PostReportRequest,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  await requireOwnDevice(db, accountId, input.reporterDeviceId)
  await db
    .insert(channelReports)
    .values({
      reportId: input.reportId,
      channelId,
      communityId,
      createdBy: accountId,
      reporterDeviceId: input.reporterDeviceId,
      reporterSig: bufOf(input.reporterSig),
    })
    .onConflictDoNothing()
  await db
    .insert(channelReportRecipients)
    .values(
      input.recipients.map((r) => ({
        reportId: input.reportId,
        recipientDeviceId: r.recipientDeviceId,
        sealedReport: bufOf(r.sealedReport),
        senderPkB64: r.senderPkB64,
      })),
    )
    .onConflictDoNothing()
  for (const a of await channelManagerAccountIds(db, communityId, channelId)) {
    registry.sendToAccount(a, {
      type: 'community.channel_report_created',
      payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
    })
  }
}

/**
 * The pending report queue as delivered to ONE moderator — only the envelopes sealed to
 * the caller's own active devices (a mod opens their own copy). Manager-only. Ordered
 * oldest-first so the review queue is stable.
 */
export async function listReports(
  db: Db,
  accountId: string,
  communityId: string,
  channelId: string,
): Promise<ListReportsResponse> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await requireChannelManager(db, channelId, membership)
  const myDevices = await db
    .select({ deviceId: devices.deviceId })
    .from(devices)
    .where(and(eq(devices.accountId, accountId), eq(devices.status, 'active')))
  const deviceIds = myDevices.map((d) => d.deviceId)
  if (deviceIds.length === 0) return { reports: [] }
  const rows = await db
    .select({
      reportId: channelReports.reportId,
      channelId: channelReports.channelId,
      reporterDeviceId: channelReports.reporterDeviceId,
      reporterSig: channelReports.reporterSig,
      status: channelReports.status,
      createdAt: channelReports.createdAt,
      sealedReport: channelReportRecipients.sealedReport,
      senderPkB64: channelReportRecipients.senderPkB64,
    })
    .from(channelReports)
    .innerJoin(
      channelReportRecipients,
      eq(channelReportRecipients.reportId, channelReports.reportId),
    )
    .where(
      and(
        eq(channelReports.channelId, channelId),
        inArray(channelReportRecipients.recipientDeviceId, deviceIds),
        eq(channelReports.status, 'pending'),
      ),
    )
    .orderBy(asc(channelReports.createdAt))
  return {
    reports: rows.map((r) => ({
      reportId: r.reportId,
      channelId: r.channelId as GroupId,
      reporterDeviceId: r.reporterDeviceId as DeviceId,
      reporterSig: r.reporterSig.toString('base64'),
      sealedReport: r.sealedReport.toString('base64'),
      senderPkB64: r.senderPkB64,
      status: r.status,
      createdAt: r.createdAt.getTime(),
    })),
  }
}

/** Manager resolves/dismisses a report (lifecycle flip; a dismissed/resolved report drops
 *  out of the pending queue). Manager-only. */
export async function resolveReport(
  db: Db,
  accountId: string,
  communityId: string,
  channelId: string,
  reportId: string,
  input: ResolveReportRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await requireChannelManager(db, channelId, membership)
  await db
    .update(channelReports)
    .set({
      status: input.action === 'resolve' ? 'resolved' : 'dismissed',
      resolvedBy: accountId,
      resolvedAt: new Date(),
    })
    .where(and(eq(channelReports.reportId, reportId), eq(channelReports.channelId, channelId)))
}

/**
 * Remove a message for everyone (moderation): hard-delete its stored ciphertext (so a
 * device that hasn't fetched it never will) and broadcast a tombstone by `seq` so devices
 * that already have it hide it. Manager-only; generalizes the author-only deleteOwnMessage.
 * The server reveals only `seq` — no content or E2EE material. Idempotent.
 */
export async function moderationRemoveMessage(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  seq: number,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await requireChannelManager(db, channelId, membership)
  await db
    .delete(mlsMessages)
    .where(and(eq(mlsMessages.groupId, channelId), eq(mlsMessages.seq, seq)))
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_message_removed',
    payload: {
      communityId: communityId as CommunityId,
      channelId: channelId as GroupId,
      seq,
    },
  })
}

/* ------------------------------- roll-calls -------------------------------- */

/**
 * Open a roll-call ("who is still here"): an artifact whose `expiresAt` is the deadline.
 * Manager-only. Members confirm with an identified, device-signed response; at the deadline a
 * manager sweeps the non-responders out in ONE key operation. This is the alternative to
 * tracking inactivity server-side: nothing is surveilled, the prompt is visible to everyone,
 * and being removed means "didn't answer", not "was offline on Tuesday".
 */
export async function startRollcall(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  input: StartRollcallRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  await requireOwnDevice(db, accountId, input.issuerDeviceId)
  // The signature binds expiresAt, so we store the deadline the CLIENT signed — we only
  // check it matches the declared window (small tolerance for clock skew / latency).
  const expected = Date.now() + input.windowMinutes * 60_000
  if (Math.abs(input.expiresAt - expected) > 5 * 60_000) {
    throw new ServiceError(400, 'rollcall_deadline')
  }
  await db
    .insert(channelArtifacts)
    .values({
      artifactId: input.artifactId,
      channelId,
      communityId,
      kind: 'rollcall',
      sealEpoch: input.sealEpoch,
      sealedBody: bufOf(input.sealedBody),
      issuerDeviceId: input.issuerDeviceId,
      issuerSig: bufOf(input.issuerSig),
      createdBy: accountId,
      expiresAt: new Date(input.expiresAt),
    })
    .onConflictDoNothing()
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
  // Reach members whose app is closed — content-free, category-gated.
  const recipients = await activeChannelAccountIds(db, channelId)
  void notifyOfflineManagers(db, recipients, communityId, (a) => registry.isAccountOnline(a))
}

/**
 * Confirm "I'm still here" for an open roll-call. Identified on purpose — the whole point is
 * knowing who did NOT answer — and device-signed so a response can't be forged by the relay.
 * Own-account only; refused once the deadline has passed.
 */
export async function respondRollcall(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
  input: PostParticipationRequest,
): Promise<void> {
  await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  await requireOwnDevice(db, accountId, input.deviceId)
  const artifact = await db.query.channelArtifacts.findFirst({
    where: and(
      eq(channelArtifacts.artifactId, artifactId),
      eq(channelArtifacts.channelId, channelId),
    ),
  })
  if (artifact?.kind !== 'rollcall') throw new ServiceError(404, 'artifact_not_found')
  if (artifact.expiresAt && artifact.expiresAt <= new Date()) {
    throw new ServiceError(409, 'rollcall_closed')
  }
  await db
    .insert(channelArtifactParticipants)
    .values({ artifactId, accountId, channelId, deviceId: input.deviceId, sig: bufOf(input.sig) })
    .onConflictDoUpdate({
      target: [channelArtifactParticipants.artifactId, channelArtifactParticipants.accountId],
      set: { deviceId: input.deviceId, sig: bufOf(input.sig) },
    })
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
}

/**
 * Sweep a closed roll-call: mark every active member who did NOT respond as removed, and
 * return them (with their devices) so the manager's client can do the key work in one
 * operation. Guardrails: never the owner, and leaders/moderators are exempt — a dormant
 * leader is a human problem, not a cron job's. Non-responders are never shown to members.
 */
export async function sweepRollcall(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
): Promise<RollcallSweepResponse> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  const artifact = await db.query.channelArtifacts.findFirst({
    where: and(
      eq(channelArtifacts.artifactId, artifactId),
      eq(channelArtifacts.channelId, channelId),
    ),
  })
  if (artifact?.kind !== 'rollcall') throw new ServiceError(404, 'artifact_not_found')
  if (!artifact.expiresAt || artifact.expiresAt > new Date()) {
    throw new ServiceError(409, 'rollcall_open')
  }

  const responded = new Set(
    (
      await db
        .select({ accountId: channelArtifactParticipants.accountId })
        .from(channelArtifactParticipants)
        .where(eq(channelArtifactParticipants.artifactId, artifactId))
    ).map((r) => r.accountId),
  )
  const exempt = await channelManagerAccountIds(db, communityId, channelId)
  const community = await db.query.communities.findFirst({
    where: eq(communities.communityId, communityId),
  })
  if (community) exempt.add(community.ownerAccountId)

  const active = await db
    .select({ accountId: channelMembers.accountId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.status, 'active')))
  const toRemove = active.map((m) => m.accountId).filter((a) => !responded.has(a) && !exempt.has(a))
  if (toRemove.length === 0) return { removedAccountIds: [], removedDeviceIds: [] }

  const devs = await db
    .select({ deviceId: devices.deviceId })
    .from(devices)
    .where(and(inArray(devices.accountId, toRemove), eq(devices.status, 'active')))
  await db
    .update(channelMembers)
    .set({ status: 'removed' })
    .where(
      and(eq(channelMembers.channelId, channelId), inArray(channelMembers.accountId, toRemove)),
    )
  // group_key: the remaining managers must rotate K_channel so the removed can't read on.
  await db
    .update(communityChannels)
    .set({ rotationPending: true })
    .where(
      and(
        eq(communityChannels.channelId, channelId),
        eq(communityChannels.encryptionMode, 'group_key'),
      ),
    )
  for (const removed of toRemove) registry.evictAccountFromChannel(removed, channelId)
  // One event for the whole sweep — clients refetch the channel rather than receiving N
  // per-member events (and non-responders are never named to members).
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
  return {
    removedAccountIds: toRemove as RollcallSweepResponse['removedAccountIds'],
    removedDeviceIds: devs.map((d) => d.deviceId) as RollcallSweepResponse['removedDeviceIds'],
  }
}

/** How far ahead of the reminder instant a departing client may "early-fire" (trades
 *  precision for coverage). The server accepts a trigger only within this look-ahead, so
 *  it can never be told a far-future time. */
const REMINDER_EARLY_WINDOW_MS = 2 * 60 * 60 * 1000
/** How stale a reminder instant may be and still fire (a slightly late trigger). */
const REMINDER_PAST_GRACE_MS = 15 * 60 * 1000

/**
 * Peer-triggered event reminder. The server can't read the E2EE event time, so member
 * clients are the clock: one that's online at reminder time calls this. We never store a
 * schedule and never learn a future time — the trigger is accepted only near "now", fans
 * a content-free 'event' push to OFFLINE RSVP'd participants, and forgets.
 *
 * Trust tiering: leaders/moderators may trigger anytime; a regular member's trigger is
 * accepted only when NO manager of the channel is currently online (409 otherwise, so the
 * client retries after a grace period). Dedup: the first trigger for a given
 * (artifact, reminderInstant) wins; later ones are no-ops.
 */
export async function triggerChannelReminder(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
  input: ReminderTriggerRequest,
): Promise<{ fired: boolean }> {
  if (!(await isActiveChannelMember(db, channelId, accountId))) {
    throw new ServiceError(403, 'not_a_channel_member')
  }
  // The server must never learn a far-future time: only accept a trigger for ~now.
  const delta = input.reminderInstant - Date.now()
  if (delta > REMINDER_EARLY_WINDOW_MS || delta < -REMINDER_PAST_GRACE_MS) {
    throw new ServiceError(400, 'reminder_window')
  }
  const artifact = await db.query.channelArtifacts.findFirst({
    where: and(
      eq(channelArtifacts.artifactId, artifactId),
      eq(channelArtifacts.channelId, channelId),
    ),
  })
  if (artifact?.kind !== 'event') throw new ServiceError(404, 'artifact_not_found')

  // Trust tier: regular members only trigger when the trusted tier is dark.
  const managers = await channelManagerAccountIds(db, communityId, channelId)
  if (!managers.has(accountId) && [...managers].some((a) => registry.isAccountOnline(a))) {
    throw new ServiceError(409, 'manager_online')
  }

  // Dedup: first writer of this key fires; concurrent/retry triggers become no-ops.
  const inserted = await db
    .insert(channelReminderFires)
    .values({ idempotencyKey: `${artifactId}:${input.reminderInstant}`, channelId })
    .onConflictDoNothing()
    .returning({ k: channelReminderFires.idempotencyKey })
  if (inserted.length === 0) return { fired: false }

  // NOTE (deliberate consequence of anonymous RSVP tickets): there is no stored
  // (account → "coming") fact any more, so a reminder CANNOT be targeted at only those who
  // RSVP'd. It goes to the channel's active members instead; the payload stays content-free
  // and each member controls the 'event' push category. Targeted reminders would require
  // re-introducing an identified RSVP — the tradeoff for not knowing who is coming.
  const recipients = await activeChannelAccountIds(db, channelId)
  void notifyEventReminder(db, recipients, communityId, (a) => registry.isAccountOnline(a))
  return { fired: true }
}

/**
 * A channel manager records their signed approval of a member's suggestion (which
 * honest clients require before they render it as an active pin under pinPolicy =
 * moderators). Coarse server gate is `requireChannelManager`; authority is verified
 * client-side against the capability chain.
 */
export async function approveArtifact(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
  input: ApproveArtifactRequest,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  await requireChannelManager(db, channelId, membership)
  await requireOwnDevice(db, accountId, input.approverDeviceId)
  const artifact = await db.query.channelArtifacts.findFirst({
    where: and(
      eq(channelArtifacts.artifactId, artifactId),
      eq(channelArtifacts.channelId, channelId),
    ),
  })
  if (!artifact) throw new ServiceError(404, 'artifact_not_found')
  await db
    .update(channelArtifacts)
    .set({ approverDeviceId: input.approverDeviceId, approvalSig: bufOf(input.approvalSig) })
    .where(eq(channelArtifacts.artifactId, artifactId))
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
}

/** Unpin: the author or a channel manager removes a pinned artifact. */
export async function deleteArtifact(
  db: Db,
  registry: ConnectionRegistry,
  accountId: string,
  communityId: string,
  channelId: string,
  artifactId: string,
): Promise<void> {
  const membership = await requireActiveMembership(db, communityId, accountId)
  await loadChannel(db, communityId, channelId)
  const artifact = await db.query.channelArtifacts.findFirst({
    where: and(
      eq(channelArtifacts.artifactId, artifactId),
      eq(channelArtifacts.channelId, channelId),
    ),
  })
  if (!artifact) throw new ServiceError(404, 'artifact_not_found')
  // The author may remove their own; otherwise a channel manager may.
  if (artifact.createdBy !== accountId) {
    await requireChannelManager(db, channelId, membership)
  }
  await db.delete(channelArtifacts).where(eq(channelArtifacts.artifactId, artifactId))
  await emitToChannel(db, registry, communityId, channelId, {
    type: 'community.channel_artifact_updated',
    payload: { communityId: communityId as CommunityId, channelId: channelId as GroupId },
  })
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
  blob: BlobStore,
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
    // Pinned artifacts re-sealed under the new K_meta: swap ciphertext + epoch in
    // place, keeping issuerSig (it binds the plaintext, so authorship survives).
    // Without this, every pin sealed under the old epoch becomes undecryptable once
    // members hold only the new key.
    for (const a of input.artifacts ?? []) {
      await tx
        .update(channelArtifacts)
        .set({ sealEpoch: a.sealEpoch, sealedBody: bufOf(a.sealedBody) })
        .where(
          and(
            eq(channelArtifacts.artifactId, a.artifactId),
            eq(channelArtifacts.communityId, communityId),
          ),
        )
    }
    // Media (avatars) re-encrypted under the new key are re-uploaded to object
    // storage AFTER the tx commits (S3 isn't transactional; a failed re-upload only
    // leaves a cosmetically-stale avatar, which the client already tolerates).

    // Old-epoch grants + commitments (incl. any to the removed member) become
    // useless — drop them (K_meta re-encrypts metadata, unlike K_channel).
    await tx
      .delete(communityKeyGrants)
      .where(
        and(
          eq(communityKeyGrants.communityId, communityId),
          lt(communityKeyGrants.keyEpoch, newEpoch),
        ),
      )
    await tx
      .delete(communityKeyEpochs)
      .where(
        and(
          eq(communityKeyEpochs.communityId, communityId),
          lt(communityKeyEpochs.keyEpoch, newEpoch),
        ),
      )
    // The authenticated commitment for the new K_meta epoch.
    await requireOwnDevice(tx, accountId, input.commitment.minterDeviceId)
    await tx
      .insert(communityKeyEpochs)
      .values({
        communityId,
        keyEpoch: newEpoch,
        keyCommitment: bufOf(input.commitment.keyCommitment),
        minterDeviceId: input.commitment.minterDeviceId,
        minterSig: bufOf(input.commitment.minterSig),
      })
      .onConflictDoNothing()

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

  // Re-upload re-encrypted avatars to object storage (post-commit, best-effort),
  // but only for media that actually belongs to this community — never let a leader
  // overwrite a foreign blob by passing an arbitrary mediaId.
  if (input.media.length > 0) {
    const owned = new Set(
      (
        await db
          .select({ mediaId: communityMedia.mediaId })
          .from(communityMedia)
          .where(eq(communityMedia.communityId, communityId))
      ).map((r) => r.mediaId),
    )
    for (const m of input.media) {
      if (owned.has(m.mediaId)) {
        await blob
          .put(communityBlobKey(m.mediaId), bufOf(m.ciphertext), 'application/octet-stream')
          .catch(() => {})
      }
    }
  }

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

type GrantableChannel = Pick<ChannelRow, 'channelId' | 'communityId' | 'access'>

/**
 * WHERE conditions for a device that may hold a K_channel grant: an active
 * device of an active channel member whose community membership also satisfies
 * the channel's access level ('leaders' channels admit only owner/leader) — the
 * SAME guard the message path enforces (satisfiesChannelAccess), so the key path
 * can't leak K_channel to a device the message path would deny.
 */
function grantableChannelConds(channel: GrantableChannel) {
  const conds = [
    eq(channelMembers.channelId, channel.channelId),
    eq(channelMembers.status, 'active'),
    eq(devices.status, 'active'),
    eq(communityMembers.communityId, channel.communityId),
    eq(communityMembers.status, 'active'),
  ]
  if (channel.access === 'leaders') {
    conds.push(inArray(communityMembers.role, ['owner', 'leader']))
  }
  return conds
}

/** Active, access-eligible devices of a channel's members (grant fan-out), optionally paged. */
async function grantableChannelDeviceRows(
  db: DbOrTx,
  channel: GrantableChannel,
  page?: { after?: string; limit: number },
) {
  const conds = grantableChannelConds(channel)
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
    .innerJoin(communityMembers, eq(communityMembers.accountId, channelMembers.accountId))
    .where(and(...conds))
  if (page) return q.orderBy(asc(devices.deviceId)).limit(page.limit)
  return q
}

/**
 * The set of device ids a grant may be sealed to — a lightweight deviceId-only
 * projection for validating a POST's grantees, so a single grant request doesn't
 * materialise every member device's cert/receipt BLOBs just to build a Set.
 */
async function eligibleChannelDeviceIds(
  db: DbOrTx,
  channel: GrantableChannel,
): Promise<Set<string>> {
  const rows = await db
    .select({ deviceId: devices.deviceId })
    .from(channelMembers)
    .innerJoin(devices, eq(devices.accountId, channelMembers.accountId))
    .innerJoin(communityMembers, eq(communityMembers.accountId, channelMembers.accountId))
    .where(and(...grantableChannelConds(channel)))
  return new Set(rows.map((r) => r.deviceId))
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
  const rows = await grantableChannelDeviceRows(db, channel, {
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

  // Only seal to access-eligible devices of active channel members — never leak K_channel.
  const allowed = await eligibleChannelDeviceIds(db, channel)
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
  const membership = await requireActiveMembership(db, communityId, accountId)
  const channel = await loadChannel(db, communityId, channelId)
  // Only an active channel member may fetch the key (a removed member is denied),
  // and only if their community role satisfies the channel's access level — the
  // same guard the message path enforces (parity: no key to a device that can't read).
  const chanMem = await db.query.channelMembers.findFirst({
    where: and(eq(channelMembers.channelId, channelId), eq(channelMembers.accountId, accountId)),
  })
  if (chanMem?.status !== 'active' || !satisfiesChannelAccess(membership, channel.access)) {
    throw new ServiceError(403, 'not_a_member')
  }

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

    // New-epoch grants — only for access-eligible devices of still-active members.
    const allowed = await eligibleChannelDeviceIds(tx, channel)
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

/** Drop reminder-dedup rows once they can no longer collide with a live/retrying trigger
 *  (well past the accept window). Keeps the ledger from growing unbounded. */
export async function pruneReminderFires(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const deleted = await db
    .delete(channelReminderFires)
    .where(lt(channelReminderFires.firedAt, cutoff))
    .returning({ k: channelReminderFires.idempotencyKey })
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
