import { z } from 'zod'
import {
  CHANNEL_ARTIFACT_BODY_MAX_B64,
  CHANNEL_KEY_GRANT_BATCH_MAX,
  CHANNEL_MESSAGE_TTL_DAYS,
  COMMUNITY_META_MAX_B64,
} from '../constants.ts'
import {
  accountIdSchema,
  communityIdSchema,
  deviceIdSchema,
  groupIdSchema,
  inviteCodeSchema,
  mediaIdSchema,
} from '../ids.ts'

/**
 * Communities — Hub/device-session surface (`/api/v1/communities/…`, Bearer
 * `gn.`). A community owns roles (owner/leader/member) and multiple joinable
 * E2EE channels. Each channel's `channelId` doubles as the MLS groupId
 * (groups.kind='channel'), joined by the member's real devices. Invite-only,
 * no public directory.
 *
 * Communities v2: channel + community *display* metadata (title/emoji/markdown
 * description, avatar) is end-to-end encrypted under a per-community K_meta the
 * server never sees — it stores/serves opaque `metaCiphertext` blobs and
 * encrypted avatar media only. Channels gain visibility (listed/unlisted),
 * join policy (open/request), per-channel moderators, targeted + code invites,
 * and per-channel disappearing-message TTLs.
 */

export const communityRoleSchema = z.enum(['owner', 'leader', 'member'])
export type CommunityRole = z.infer<typeof communityRoleSchema>

/** Roles an owner can assign — never 'owner' (transfer is a separate concern). */
export const assignableRoleSchema = z.enum(['leader', 'member'])
export type AssignableRole = z.infer<typeof assignableRoleSchema>

export const channelAccessSchema = z.enum(['members', 'leaders'])
export type ChannelAccess = z.infer<typeof channelAccessSchema>

export const channelVisibilitySchema = z.enum(['listed', 'unlisted'])
export type ChannelVisibility = z.infer<typeof channelVisibilitySchema>

export const channelJoinPolicySchema = z.enum(['open', 'request'])
export type ChannelJoinPolicy = z.infer<typeof channelJoinPolicySchema>

/** everyone = any active member posts; moderators = read-only for non-mods. */
export const channelPostPolicySchema = z.enum(['everyone', 'moderators'])
export type ChannelPostPolicy = z.infer<typeof channelPostPolicySchema>

/** everyone = any member pins directly; moderators = members suggest, managers approve. */
export const channelPinPolicySchema = z.enum(['everyone', 'moderators'])
export type ChannelPinPolicy = z.infer<typeof channelPinPolicySchema>

/**
 * mls = one MLS group per channel (per-message forward secrecy, immediate
 * removal), the default for small/sensitive channels. group_key = a shared
 * per-channel K_channel (epoch'd, ECIES-granted per device) for large
 * broadcast/discussion channels MLS cannot scale to.
 */
export const channelEncryptionModeSchema = z.enum(['mls', 'group_key'])
export type ChannelEncryptionMode = z.infer<typeof channelEncryptionModeSchema>

/** The caller's own membership state in a channel, for directory rendering. */
export const channelMyStatusSchema = z.enum(['active', 'pending', 'invited', 'none'])
export type ChannelMyStatus = z.infer<typeof channelMyStatusSchema>

export const channelMemberRoleSchema = z.enum(['member', 'moderator'])
export type ChannelMemberRole = z.infer<typeof channelMemberRoleSchema>

/** Sealed {title/name, emoji?, description?} blob (base64) — server-opaque. */
const metaCiphertextSchema = z.base64().max(COMMUNITY_META_MAX_B64)

export const messageTtlDaysSchema = z
  .number()
  .int()
  .refine((v) => (CHANNEL_MESSAGE_TTL_DAYS as readonly number[]).includes(v), {
    message: 'invalid_ttl',
  })

/* -------------------------------- community ------------------------------- */

export const createCommunityRequestSchema = z.object({
  /** seal(K_meta, {name, description?}); optional so a community can start bare */
  metaCiphertext: metaCiphertextSchema.optional(),
  avatarMediaId: mediaIdSchema.optional(),
})

export const createCommunityResponseSchema = z.object({
  communityId: communityIdSchema,
})

export const updateCommunityRequestSchema = z
  .object({
    metaCiphertext: metaCiphertextSchema.optional(),
    avatarMediaId: mediaIdSchema.nullable().optional(),
  })
  .refine((v) => v.metaCiphertext !== undefined || v.avatarMediaId !== undefined, {
    message: 'no fields to update',
  })

export const communityListItemSchema = z.object({
  communityId: communityIdSchema,
  metaCiphertext: z.string().nullable(),
  avatarMediaId: z.string().nullable(),
  keyEpoch: z.number().int().nonnegative(),
  /** true → a leader's client should rotate K_meta (re-encrypt metadata) */
  rotationPending: z.boolean(),
  /** true → some group_key channel here needs K_channel rotation (fetch detail) */
  channelRotationPending: z.boolean(),
  myRole: communityRoleSchema,
  channelCount: z.number().int().nonnegative(),
})

export const communitiesResponseSchema = z.object({
  communities: z.array(communityListItemSchema),
})

export const communityMemberSchema = z.object({
  accountId: accountIdSchema,
  displayName: z.string(),
  role: communityRoleSchema,
})

/** Cursor pagination for large rosters/device lists. `after` = last id seen. */
export const paginationQuerySchema = z.object({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type PaginationQuery = z.infer<typeof paginationQuerySchema>

/** A page of community members; `nextCursor` null when the roster is exhausted. */
export const communityMembersPageResponseSchema = z.object({
  members: z.array(communityMemberSchema),
  nextCursor: z.string().nullable(),
})

export const communityChannelSchema = z.object({
  channelId: groupIdSchema,
  metaCiphertext: z.string().nullable(),
  avatarMediaId: z.string().nullable(),
  access: channelAccessSchema,
  visibility: channelVisibilitySchema,
  joinPolicy: channelJoinPolicySchema,
  postPolicy: channelPostPolicySchema,
  pinPolicy: channelPinPolicySchema,
  messageTtlDays: z.number().int(),
  position: z.number().int(),
  /** the caller's channel-membership state */
  myStatus: channelMyStatusSchema,
  /** the caller's channel role (only meaningful when myStatus='active') */
  myRole: channelMemberRoleSchema,
  /** whether the caller is muted here (read-only regardless of postPolicy) */
  muted: z.boolean(),
  /** at least one of the caller's devices holds an active MLS leaf (mls channels only) */
  joined: z.boolean(),
  currentEpoch: z.number().int().nonnegative(),
  /** base64 latest GroupInfo — released only to active mls-channel members; null for group_key */
  groupInfo: z.base64().nullable(),
  /** mls vs group_key */
  encryptionMode: channelEncryptionModeSchema,
  /** group_key only: current K_channel epoch the client must hold to read/write */
  keyEpoch: z.number().int().nonnegative(),
  /** group_key only: true → a manager's client should rotate K_channel */
  rotationPending: z.boolean(),
})

/* ----------------- identity-signed membership/role capabilities ----------- */

/** owner|leader|member (community scope) or moderator|member (a channel scope). */
export const capabilityRoleSchema = z.enum(['owner', 'leader', 'member', 'moderator'])
export type CapabilityRole = z.infer<typeof capabilityRoleSchema>

/**
 * An identity-signed membership/role capability: an issuer device (cert-chained to
 * its account) attests that `subjectAccountId` holds `role` in `communityId` at
 * `scope` ('community' or a channelId) for `epoch`. Verified client-side against the
 * pinned community owner root — the server relays it but is never trusted for
 * membership. `issuerSig = Ed25519(issuerDeviceKey, domain.membershipCap ‖
 * communityId ‖ scope ‖ subjectAccountId ‖ role ‖ epoch)`.
 */
export const membershipCapabilitySchema = z.object({
  communityId: communityIdSchema,
  scope: z.string().min(1).max(64),
  subjectAccountId: accountIdSchema,
  role: capabilityRoleSchema,
  epoch: z.number().int().nonnegative(),
  issuerDeviceId: deviceIdSchema,
  issuerSig: z.base64(),
})
export type MembershipCapability = z.infer<typeof membershipCapabilitySchema>

/**
 * The community owner's device attestation of ownership — the root every capability
 * chain terminates at. `ownerSig = Ed25519(ownerDeviceKey, domain.communityRoot ‖
 * communityId ‖ ownerAccountId)`. The `ownerAccountId` is pinned client-side from
 * the out-of-band invite, so a compromised server can't swap the owner.
 */
export const communityRootSchema = z.object({
  communityId: communityIdSchema,
  ownerAccountId: accountIdSchema,
  ownerDeviceId: deviceIdSchema,
  ownerSig: z.base64(),
})
export type CommunityRoot = z.infer<typeof communityRootSchema>

/** Client posts the owner-signed community root after creating the community. */
export const setCommunityRootRequestSchema = z.object({
  ownerDeviceId: deviceIdSchema,
  ownerSig: z.base64(),
})

/** An issuer posts membership capabilities it minted (server relays, never mints). */
export const postCapabilitiesRequestSchema = z.object({
  capabilities: z.array(membershipCapabilitySchema).min(1).max(500),
})

/** The caller's own capabilities at the community's current epoch. */
export const myCapabilitiesResponseSchema = z.object({
  epoch: z.number().int().nonnegative(),
  capabilities: z.array(membershipCapabilitySchema),
})

/** A specific account's capability at a scope (current epoch) — for chain verification. */
export const capabilityResponseSchema = z.object({
  capability: membershipCapabilitySchema.nullable(),
})

export type PostCapabilitiesRequest = z.infer<typeof postCapabilitiesRequestSchema>
export type MyCapabilitiesResponse = z.infer<typeof myCapabilitiesResponseSchema>
export type CapabilityResponse = z.infer<typeof capabilityResponseSchema>

/* ------------------- pinned channel artifacts (relayed) ------------------- */

/** pin (a message snapshot) | link | media | event (one-shot). */
export const channelArtifactKindSchema = z.enum(['pin', 'link', 'media', 'event'])
export type ChannelArtifactKind = z.infer<typeof channelArtifactKindSchema>

/**
 * A pinned channel artifact — an independent, device-signed, sealed record (not a
 * message). `sealedBody = seal(K_meta, body)` at `sealEpoch`; the server relays it but
 * never reads or validates it. `issuerSig = Ed25519(issuerDeviceKey, domain.channelArtifact
 * ‖ channelId ‖ artifactId ‖ kind ‖ u64(sealEpoch) ‖ u64(expiresAtMs) ‖ H(sealedBody))`.
 * A member's suggestion becomes an active pin when a channel manager sets `approvalSig`
 * (over domain.channelArtifact ‖ 'approve' ‖ channelId ‖ artifactId). Clients verify both
 * against the capability chain + the channel's pinPolicy.
 */
export const channelArtifactSchema = z.object({
  artifactId: z.uuid(),
  channelId: groupIdSchema,
  kind: channelArtifactKindSchema,
  sealEpoch: z.number().int().nonnegative(),
  sealedBody: z.base64().max(CHANNEL_ARTIFACT_BODY_MAX_B64),
  issuerDeviceId: deviceIdSchema,
  issuerSig: z.base64(),
  approverDeviceId: deviceIdSchema.nullable(),
  approvalSig: z.base64().nullable(),
  createdBy: accountIdSchema,
  /** epoch millis (server clock) */
  createdAt: z.number().int().nonnegative(),
  /** epoch millis; null = pinned forever */
  expiresAt: z.number().int().nonnegative().nullable(),
})
export type ChannelArtifact = z.infer<typeof channelArtifactSchema>

/** Author posts a pinned artifact it minted (server relays, never validates). */
export const postArtifactRequestSchema = z.object({
  artifactId: z.uuid(),
  kind: channelArtifactKindSchema,
  sealEpoch: z.number().int().nonnegative(),
  sealedBody: z.base64().max(CHANNEL_ARTIFACT_BODY_MAX_B64),
  issuerDeviceId: deviceIdSchema,
  issuerSig: z.base64(),
  expiresAt: z.number().int().positive().nullable().optional(),
})
export type PostArtifactRequest = z.infer<typeof postArtifactRequestSchema>

/** A channel manager approves a member's suggestion (promotes it to an active pin). */
export const approveArtifactRequestSchema = z.object({
  approverDeviceId: deviceIdSchema,
  approvalSig: z.base64(),
})
export type ApproveArtifactRequest = z.infer<typeof approveArtifactRequestSchema>

export const listArtifactsResponseSchema = z.object({
  artifacts: z.array(channelArtifactSchema),
})
export type ListArtifactsResponse = z.infer<typeof listArtifactsResponseSchema>

export const communityDetailResponseSchema = z.object({
  community: z.object({
    communityId: communityIdSchema,
    metaCiphertext: z.string().nullable(),
    avatarMediaId: z.string().nullable(),
    keyEpoch: z.number().int().nonnegative(),
    /** true → a leader's client should rotate K_meta (re-encrypt metadata) */
    rotationPending: z.boolean(),
    ownerAccountId: accountIdSchema,
    /** the owner-signed ownership root (capability-chain anchor); null if not yet set */
    root: communityRootSchema.nullable(),
  }),
  myRole: communityRoleSchema,
  /** first page of active members (≤ COMMUNITY_MEMBER_PAGE_SIZE); page the rest via GET …/members */
  members: z.array(communityMemberSchema),
  /** total active-member count (members may be a truncated first page) */
  memberCount: z.number().int().nonnegative(),
  channels: z.array(communityChannelSchema),
})

/* --------------------------------- media ---------------------------------- */

export const uploadMediaRequestSchema = z.object({
  /** seal(K_meta, imageBytes) — base64 ciphertext, size-capped server-side */
  ciphertext: z.base64(),
})

export const uploadMediaResponseSchema = z.object({
  mediaId: mediaIdSchema,
})

/* --------------------------------- invites -------------------------------- */

export const createCommunityInviteRequestSchema = z.object({
  maxUses: z.number().int().min(1).max(1000).default(25),
  ttlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24 * 14),
})

export const communityInviteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  maxUses: z.number().int(),
  useCount: z.number().int(),
  expiresAt: z.number().int(),
  createdAt: z.number().int(),
})

export const communityInvitesResponseSchema = z.object({
  invites: z.array(communityInviteSchema),
})

export const acceptCommunityInviteRequestSchema = z.object({
  code: inviteCodeSchema,
})

export const acceptCommunityInviteResponseSchema = z.object({
  communityId: communityIdSchema,
})

/* -------------------------------- channels -------------------------------- */

export const createChannelRequestSchema = z.object({
  metaCiphertext: metaCiphertextSchema.optional(),
  avatarMediaId: mediaIdSchema.optional(),
  access: channelAccessSchema.default('members'),
  visibility: channelVisibilitySchema.default('listed'),
  joinPolicy: channelJoinPolicySchema.default('open'),
  postPolicy: channelPostPolicySchema.default('everyone'),
  /** omit to derive from encryptionMode (mls → everyone, group_key → moderators). */
  pinPolicy: channelPinPolicySchema.optional(),
  messageTtlDays: messageTtlDaysSchema.default(30),
  /** mls (default) vs group_key. group_key channels publish no MLS GroupInfo. */
  encryptionMode: channelEncryptionModeSchema.default('mls'),
})

export const createChannelResponseSchema = z.object({
  channelId: groupIdSchema,
})

export const updateChannelRequestSchema = z
  .object({
    metaCiphertext: metaCiphertextSchema.optional(),
    avatarMediaId: mediaIdSchema.nullable().optional(),
    access: channelAccessSchema.optional(),
    visibility: channelVisibilitySchema.optional(),
    joinPolicy: channelJoinPolicySchema.optional(),
    postPolicy: channelPostPolicySchema.optional(),
    pinPolicy: channelPinPolicySchema.optional(),
    messageTtlDays: messageTtlDaysSchema.optional(),
    position: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'no fields to update',
  })

/** Epoch-0 GroupInfo publish — the channel creator's first act. */
export const publishChannelGroupInfoRequestSchema = z.object({
  groupInfo: z.base64(),
  /** the creator's device — becomes the first MLS leaf */
  deviceId: z.string().regex(/^[0-9a-f]{32}$/),
})

/** Response for join/join-by-code and GET channel: current state + join keys. */
export const channelJoinInfoResponseSchema = z.object({
  channelId: groupIdSchema,
  communityId: communityIdSchema,
  /** the caller's channel-membership state after the call */
  status: channelMyStatusSchema,
  access: channelAccessSchema,
  /** mls: released only when status='active'. group_key: always null (no MLS group). */
  groupInfo: z.base64().nullable(),
  /** mls channel epoch (0 for group_key) */
  epoch: z.number().int().nonnegative(),
  encryptionMode: channelEncryptionModeSchema,
  /** group_key only: the K_channel epoch the caller must fetch a grant for */
  keyEpoch: z.number().int().nonnegative(),
})

export const joinByCodeRequestSchema = z.object({
  code: inviteCodeSchema,
})

/* ------------------------ channel requests / invites ---------------------- */

export const resolveJoinRequestSchema = z.object({
  action: z.enum(['accept', 'decline']),
})

export const createChannelInviteRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('targeted'),
    inviteeAccountId: accountIdSchema,
  }),
  z.object({
    kind: z.literal('code'),
    maxUses: z.number().int().min(1).max(1000).default(25),
    ttlHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(24 * 14),
  }),
])

export const channelInviteResponseSchema = z.object({
  /** present for kind='code' */
  code: z.string().nullable(),
})

export const setModeratorRequestSchema = z.object({
  action: z.enum(['set', 'unset']),
})

/** Channel roster (manager-only) — active members, pending requests, invitees. */
export const channelMemberSchema = z.object({
  accountId: accountIdSchema,
  displayName: z.string(),
  status: z.enum(['active', 'pending', 'invited']),
  role: channelMemberRoleSchema,
  muted: z.boolean(),
})

export const setMutedRequestSchema = z.object({
  muted: z.boolean(),
})

/* ----------------------- K_meta cross-device grants ----------------------- */

/**
 * Authenticated per-epoch key commitment, shared by K_meta (community_key_epochs)
 * and K_channel (channel_key_epochs): binds the sealed key to its scope+epoch so a
 * grantee can detect substitution/partition. `scopeId` = communityId or channelId.
 */
export const keyCommitmentSchema = z.object({
  /** base64 SHA-256(scopeId ‖ keyEpoch ‖ key) */
  keyCommitment: z.base64(),
  /** device that minted this epoch's key (resolve its cert via the scope's device list) */
  minterDeviceId: deviceIdSchema,
  /** base64 Ed25519(minterDeviceKey, domain ‖ scopeId ‖ keyEpoch ‖ keyCommitment) */
  minterSig: z.base64(),
})

/**
 * A community member device that can receive a K_meta grant. The caller
 * authenticates `receiptPk` itself: verify `certSig` over `deviceCert` under the
 * member's account identity (accountId = base58 identity pk), then verify
 * `receiptPkSig` over `receiptPk` under the cert's device key. The server is
 * never trusted for `receiptPk`.
 */
export const communityDeviceSchema = z.object({
  accountId: accountIdSchema,
  deviceId: deviceIdSchema,
  deviceCert: z.base64(),
  certSig: z.base64(),
  // null when the device never registered a receipt key: the DeviceCert (used for
  // signature verification) is always present, but such a device can't receive a
  // K_meta/K_channel grant (nothing to seal to) and is skipped by the grant paths.
  receiptPk: z.base64().nullable(),
  receiptPkSig: z.base64().nullable(),
})

export const communityDevicesResponseSchema = z.object({
  keyEpoch: z.number().int().nonnegative(),
  devices: z.array(communityDeviceSchema),
  /** null when all grantable devices have been returned; else pass as `after` */
  nextCursor: z.string().nullable(),
})

/** A single member device by id (capability-issuer resolution across paged rosters). */
export const communityDeviceResponseSchema = z.object({
  device: communityDeviceSchema.nullable(),
})
export type CommunityDeviceResponse = z.infer<typeof communityDeviceResponseSchema>

export const keyGrantSchema = z.object({
  granteeDeviceId: deviceIdSchema,
  /** eciesSeal(receiptPk, K_meta) */
  sealedKMeta: z.base64(),
  senderPkB64: z.base64(),
})

export const postKeyGrantsRequestSchema = z.object({
  keyEpoch: z.number().int().nonnegative(),
  /** required the first time an epoch is seen; ignored (idempotent) afterwards */
  commitment: keyCommitmentSchema.optional(),
  grants: z.array(keyGrantSchema).min(1).max(500),
})

export const myKeyGrantResponseSchema = z.object({
  keyEpoch: z.number().int().nonnegative(),
  /** null when no grant exists for this device at the current epoch */
  grant: z.object({ sealedKMeta: z.base64(), senderPkB64: z.base64() }).nullable(),
  /** the authenticated epoch commitment; null until a minter has published it */
  commitment: keyCommitmentSchema.nullable(),
})

/**
 * K_meta rotation (member removal → forward secrecy). A leader's client
 * generates a new K_meta, re-encrypts all metadata + media under it, and posts
 * this in one shot. The server applies it atomically with a compare-and-set on
 * `fromEpoch` (concurrent rotations lose and retry). The server sees only
 * ciphertext — never the old or new K_meta.
 */
export const rotateRequestSchema = z.object({
  fromEpoch: z.number().int().nonnegative(),
  /** authenticated commitment binding the new K_meta to the community + new epoch */
  commitment: keyCommitmentSchema,
  /** re-encrypted community metadata under the new key (null if none) */
  community: z.object({ metaCiphertext: metaCiphertextSchema.nullable() }),
  /** re-encrypted channel metadata under the new key */
  channels: z.array(
    z.object({ channelId: groupIdSchema, metaCiphertext: metaCiphertextSchema.nullable() }),
  ),
  /** re-sealed avatar media (ciphertext replaced in place, mediaId kept) */
  media: z.array(z.object({ mediaId: mediaIdSchema, ciphertext: z.base64() })),
  /** new-epoch grants sealed to every remaining active-member device */
  grants: z.array(keyGrantSchema),
})

export const channelMembersResponseSchema = z.object({
  members: z.array(channelMemberSchema),
  /** null when the roster is exhausted; else pass as `after` */
  nextCursor: z.string().nullable(),
})

/* ------------------------ K_channel (group_key) grants -------------------- */

/**
 * K_channel distribution for group_key channels. Mirrors the K_meta grant flow
 * (per-device ECIES receipt-key seals) but scoped to a channel and minted only
 * by an authorized granter set (channel moderators / community leaders). Each
 * epoch carries an authenticated `commitment` (see keyCommitmentSchema) so a
 * grantee can prove the key it opened is the one authority published.
 */

/** Devices eligible for a K_channel grant = the channel's active-member devices. */
export const channelDevicesResponseSchema = z.object({
  keyEpoch: z.number().int().nonnegative(),
  devices: z.array(communityDeviceSchema),
  /** null when all grantable devices have been returned; else pass as `after` */
  nextCursor: z.string().nullable(),
})

export const channelKeyGrantSchema = z.object({
  granteeDeviceId: deviceIdSchema,
  /** eciesSeal(receiptPk, K_channel[keyEpoch]) */
  sealedKey: z.base64(),
  senderPkB64: z.base64(),
})

export const postChannelKeyGrantsRequestSchema = z.object({
  keyEpoch: z.number().int().nonnegative(),
  /** required the first time an epoch is seen; ignored (idempotent) afterwards */
  commitment: keyCommitmentSchema.optional(),
  grants: z.array(channelKeyGrantSchema).min(1).max(CHANNEL_KEY_GRANT_BATCH_MAX),
})

export const myChannelKeyGrantResponseSchema = z.object({
  keyEpoch: z.number().int().nonnegative(),
  /** null when no grant exists for this device at the current epoch */
  grant: z.object({ sealedKey: z.base64(), senderPkB64: z.base64() }).nullable(),
  /** the authenticated epoch commitment; null until a minter has published it */
  commitment: keyCommitmentSchema.nullable(),
})

/**
 * Rotate a group_key channel to a fresh K_channel epoch (member removed/left, or
 * periodic PCS refresh). Unlike K_meta rotation, messages are NOT re-encrypted —
 * old messages stay under their old epoch and expire at the channel TTL. The
 * server applies a compare-and-set on the channel `keyEpoch`. `grants` is an
 * initial batch (at least the minter's own devices); the client tops up the
 * remaining member devices via postChannelKeyGrants at the new epoch.
 */
export const rotateChannelRequestSchema = z.object({
  fromEpoch: z.number().int().nonnegative(),
  commitment: keyCommitmentSchema,
  grants: z.array(channelKeyGrantSchema).min(1).max(CHANNEL_KEY_GRANT_BATCH_MAX),
})

/* ---------------------------------- roles --------------------------------- */

export const setMemberRoleRequestSchema = z.object({
  role: assignableRoleSchema,
})

export type CreateCommunityRequest = z.infer<typeof createCommunityRequestSchema>
export type CreateCommunityResponse = z.infer<typeof createCommunityResponseSchema>
export type UpdateCommunityRequest = z.infer<typeof updateCommunityRequestSchema>
export type CommunityListItem = z.infer<typeof communityListItemSchema>
export type CommunityMember = z.infer<typeof communityMemberSchema>
export type CommunityMembersPageResponse = z.infer<typeof communityMembersPageResponseSchema>
export type CommunityChannel = z.infer<typeof communityChannelSchema>
export type CommunityDetailResponse = z.infer<typeof communityDetailResponseSchema>
export type UploadMediaRequest = z.infer<typeof uploadMediaRequestSchema>
export type UploadMediaResponse = z.infer<typeof uploadMediaResponseSchema>
export type CreateCommunityInviteRequest = z.infer<typeof createCommunityInviteRequestSchema>
export type CommunityInvite = z.infer<typeof communityInviteSchema>
export type AcceptCommunityInviteRequest = z.infer<typeof acceptCommunityInviteRequestSchema>
export type AcceptCommunityInviteResponse = z.infer<typeof acceptCommunityInviteResponseSchema>
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>
export type CreateChannelResponse = z.infer<typeof createChannelResponseSchema>
export type UpdateChannelRequest = z.infer<typeof updateChannelRequestSchema>
export type PublishChannelGroupInfoRequest = z.infer<typeof publishChannelGroupInfoRequestSchema>
export type ChannelJoinInfoResponse = z.infer<typeof channelJoinInfoResponseSchema>
export type JoinByCodeRequest = z.infer<typeof joinByCodeRequestSchema>
export type ResolveJoinRequest = z.infer<typeof resolveJoinRequestSchema>
export type CreateChannelInviteRequest = z.infer<typeof createChannelInviteRequestSchema>
export type ChannelInviteResponse = z.infer<typeof channelInviteResponseSchema>
export type SetModeratorRequest = z.infer<typeof setModeratorRequestSchema>
export type ChannelMemberEntry = z.infer<typeof channelMemberSchema>
export type ChannelMembersResponse = z.infer<typeof channelMembersResponseSchema>
export type SetMutedRequest = z.infer<typeof setMutedRequestSchema>
export type CommunityDevice = z.infer<typeof communityDeviceSchema>
export type CommunityDevicesResponse = z.infer<typeof communityDevicesResponseSchema>
export type KeyGrant = z.infer<typeof keyGrantSchema>
export type PostKeyGrantsRequest = z.infer<typeof postKeyGrantsRequestSchema>
export type MyKeyGrantResponse = z.infer<typeof myKeyGrantResponseSchema>
export type RotateRequest = z.infer<typeof rotateRequestSchema>
export type SetMemberRoleRequest = z.infer<typeof setMemberRoleRequestSchema>
export type KeyCommitment = z.infer<typeof keyCommitmentSchema>
export type ChannelDevicesResponse = z.infer<typeof channelDevicesResponseSchema>
export type ChannelKeyGrant = z.infer<typeof channelKeyGrantSchema>
export type PostChannelKeyGrantsRequest = z.infer<typeof postChannelKeyGrantsRequestSchema>
export type MyChannelKeyGrantResponse = z.infer<typeof myChannelKeyGrantResponseSchema>
export type RotateChannelRequest = z.infer<typeof rotateChannelRequestSchema>
