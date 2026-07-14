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

export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>
export type Invite = z.infer<typeof inviteSchema>
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>
export type Friend = z.infer<typeof friendSchema>
