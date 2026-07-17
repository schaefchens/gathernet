import { z } from 'zod'
import { CHANNEL_MESSAGE_TTL_DAYS, COMMUNITY_META_MAX_B64 } from '../constants.ts'
import {
  accountIdSchema,
  communityIdSchema,
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

export const communityChannelSchema = z.object({
  channelId: groupIdSchema,
  metaCiphertext: z.string().nullable(),
  avatarMediaId: z.string().nullable(),
  access: channelAccessSchema,
  visibility: channelVisibilitySchema,
  joinPolicy: channelJoinPolicySchema,
  postPolicy: channelPostPolicySchema,
  messageTtlDays: z.number().int(),
  position: z.number().int(),
  /** the caller's channel-membership state */
  myStatus: channelMyStatusSchema,
  /** the caller's channel role (only meaningful when myStatus='active') */
  myRole: channelMemberRoleSchema,
  /** whether the caller is muted here (read-only regardless of postPolicy) */
  muted: z.boolean(),
  /** at least one of the caller's devices holds an active MLS leaf */
  joined: z.boolean(),
  currentEpoch: z.number().int().nonnegative(),
  /** base64 latest GroupInfo — released only to active channel members */
  groupInfo: z.base64().nullable(),
})

export const communityDetailResponseSchema = z.object({
  community: z.object({
    communityId: communityIdSchema,
    metaCiphertext: z.string().nullable(),
    avatarMediaId: z.string().nullable(),
    ownerAccountId: accountIdSchema,
  }),
  myRole: communityRoleSchema,
  members: z.array(communityMemberSchema),
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
  messageTtlDays: messageTtlDaysSchema.default(30),
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
  /** the caller's channel-membership state after the call */
  status: channelMyStatusSchema,
  access: channelAccessSchema,
  /** released only when status='active' */
  groupInfo: z.base64().nullable(),
  epoch: z.number().int().nonnegative(),
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

export const channelMembersResponseSchema = z.object({
  members: z.array(channelMemberSchema),
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
export type SetMemberRoleRequest = z.infer<typeof setMemberRoleRequestSchema>
