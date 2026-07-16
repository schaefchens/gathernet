import { z } from 'zod'
import { accountIdSchema, communityIdSchema, groupIdSchema, inviteCodeSchema } from '../ids.ts'

/**
 * Communities — Hub/device-session surface (`/api/v1/communities/…`, Bearer
 * `gn.`). A community owns roles (owner/leader/member) and multiple joinable
 * E2EE channels. Each channel's `channelId` doubles as the MLS groupId
 * (groups.kind='channel'), joined by the member's real devices. Invite-only,
 * no public directory.
 */

export const communityRoleSchema = z.enum(['owner', 'leader', 'member'])
export type CommunityRole = z.infer<typeof communityRoleSchema>

/** Roles an owner can assign — never 'owner' (transfer is a separate concern). */
export const assignableRoleSchema = z.enum(['leader', 'member'])
export type AssignableRole = z.infer<typeof assignableRoleSchema>

export const channelAccessSchema = z.enum(['members', 'leaders'])
export type ChannelAccess = z.infer<typeof channelAccessSchema>

const nameSchema = z.string().trim().min(1).max(80)
const descriptionSchema = z.string().trim().max(500)
const iconUrlSchema = z.string().trim().url().max(2048)

/* -------------------------------- community ------------------------------- */

export const createCommunityRequestSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  iconUrl: iconUrlSchema.optional(),
})

export const createCommunityResponseSchema = z.object({
  communityId: communityIdSchema,
})

export const updateCommunityRequestSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    iconUrl: iconUrlSchema.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.iconUrl !== undefined, {
    message: 'no fields to update',
  })

export const communityListItemSchema = z.object({
  communityId: communityIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
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
  name: z.string(),
  access: channelAccessSchema,
  position: z.number().int(),
  /** at least one of the caller's devices holds an active MLS leaf */
  joined: z.boolean(),
  currentEpoch: z.number().int().nonnegative(),
  /** base64 latest GroupInfo for external joins — null until published */
  groupInfo: z.base64().nullable(),
})

export const communityDetailResponseSchema = z.object({
  community: z.object({
    communityId: communityIdSchema,
    name: z.string(),
    description: z.string().nullable(),
    iconUrl: z.string().nullable(),
    ownerAccountId: accountIdSchema,
  }),
  myRole: communityRoleSchema,
  members: z.array(communityMemberSchema),
  channels: z.array(communityChannelSchema),
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
  name: nameSchema,
  access: channelAccessSchema.default('members'),
  joinDefault: z.boolean().default(true),
})

export const createChannelResponseSchema = z.object({
  channelId: groupIdSchema,
})

/** Epoch-0 GroupInfo publish — the channel creator's first act. */
export const publishChannelGroupInfoRequestSchema = z.object({
  groupInfo: z.base64(),
  /** the creator's device — becomes the first MLS leaf */
  deviceId: z.string().regex(/^[0-9a-f]{32}$/),
})

export const channelJoinInfoResponseSchema = z.object({
  channelId: groupIdSchema,
  groupInfo: z.base64().nullable(),
  epoch: z.number().int().nonnegative(),
  access: channelAccessSchema,
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
export type CreateCommunityInviteRequest = z.infer<typeof createCommunityInviteRequestSchema>
export type CommunityInvite = z.infer<typeof communityInviteSchema>
export type AcceptCommunityInviteRequest = z.infer<typeof acceptCommunityInviteRequestSchema>
export type AcceptCommunityInviteResponse = z.infer<typeof acceptCommunityInviteResponseSchema>
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>
export type CreateChannelResponse = z.infer<typeof createChannelResponseSchema>
export type PublishChannelGroupInfoRequest = z.infer<typeof publishChannelGroupInfoRequestSchema>
export type ChannelJoinInfoResponse = z.infer<typeof channelJoinInfoResponseSchema>
export type SetMemberRoleRequest = z.infer<typeof setMemberRoleRequestSchema>
