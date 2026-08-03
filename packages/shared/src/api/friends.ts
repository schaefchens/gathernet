import { z } from 'zod'
import { accountIdSchema, inviteCodeSchema } from '../ids.ts'

export const createInviteRequestSchema = z.object({
  /** 1 = single-use (default); capped server-side */
  maxUses: z.number().int().min(1).max(50).default(1),
  ttlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
})

export const inviteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  maxUses: z.number().int(),
  useCount: z.number().int(),
  expiresAt: z.number().int(),
  createdAt: z.number().int(),
})

export const invitesResponseSchema = z.object({
  invites: z.array(inviteSchema),
})

export const acceptInviteRequestSchema = z.object({
  code: inviteCodeSchema,
})

export const friendSchema = z.object({
  accountId: accountIdSchema,
  displayName: z.string(),
  since: z.number().int(),
})

export const friendsResponseSchema = z.object({
  friends: z.array(friendSchema),
})

/**
 * Block a friend/account for a bounded window — time-limited BY DESIGN (no permanent
 * block; a season of space, then the door reopens). Duration in hours, capped at ~1y.
 */
export const blockRequestSchema = z.object({
  durationHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365),
})

/** An active block the caller holds ("taking space from"). */
export const blockSchema = z.object({
  accountId: accountIdSchema,
  displayName: z.string(),
  /** epoch ms when the block auto-lifts */
  expiresAt: z.number().int(),
})

export const blocksResponseSchema = z.object({
  blocks: z.array(blockSchema),
})

export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>
export type Invite = z.infer<typeof inviteSchema>
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>
export type Friend = z.infer<typeof friendSchema>
export type BlockRequest = z.infer<typeof blockRequestSchema>
export type Block = z.infer<typeof blockSchema>
export type BlocksResponse = z.infer<typeof blocksResponseSchema>
