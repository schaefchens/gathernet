import { z } from 'zod'
import { accountIdSchema, deviceIdSchema, inviteCodeSchema } from '../ids.ts'
import { communityDeviceSchema } from './communities.ts'

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

/* -------------------- connect requests (directed, in-community) ------------------- */

/** The target's active devices a connect request's intro is sealed to (ECIES per device).
 *  A small directed lookup — never a browsable roster. Reuses communityDeviceSchema. */
export const connectRecipientsResponseSchema = z.object({
  devices: z.array(communityDeviceSchema),
})
export type ConnectRecipientsResponse = z.infer<typeof connectRecipientsResponseSchema>

/** One per-device ECIES envelope of the (identical) sealed intro message. */
export const connectRecipientSchema = z.object({
  recipientDeviceId: deviceIdSchema,
  sealed: z.base64().max(8192),
  senderPkB64: z.base64(),
})
export type ConnectRecipient = z.infer<typeof connectRecipientSchema>

/** Send a directed connect request to a community co-member, with a sealed intro. */
export const postConnectRequestSchema = z.object({
  toAccountId: accountIdSchema,
  requesterDeviceId: deviceIdSchema,
  /** Ed25519 over SIG_DOMAIN.friendConnect ‖ from ‖ to ‖ SHA-256(plaintext) */
  requesterSig: z.base64(),
  recipients: z.array(connectRecipientSchema).min(1).max(64),
})
export type PostConnectRequest = z.infer<typeof postConnectRequestSchema>

/** An incoming connect request as delivered to the target: sender identity + the envelope
 *  sealed to one of the target's own devices + verification data. */
export const incomingConnectRequestSchema = z.object({
  requestId: z.uuid(),
  fromAccountId: accountIdSchema,
  fromDisplayName: z.string(),
  requesterDeviceId: deviceIdSchema,
  /** the requester device's cert + signature, so the intro's signature can be verified
   *  self-containedly (no community-scoped device lookup needed on the friends page) */
  requesterDeviceCert: z.base64(),
  requesterCertSig: z.base64(),
  requesterSig: z.base64(),
  sealed: z.base64(),
  senderPkB64: z.base64(),
  createdAt: z.number().int().nonnegative(),
})
export type IncomingConnectRequest = z.infer<typeof incomingConnectRequestSchema>

/** An outgoing connect request the caller sent (no message echoed back). */
export const outgoingConnectRequestSchema = z.object({
  requestId: z.uuid(),
  toAccountId: accountIdSchema,
  toDisplayName: z.string(),
  createdAt: z.number().int().nonnegative(),
})
export type OutgoingConnectRequest = z.infer<typeof outgoingConnectRequestSchema>

export const connectRequestsResponseSchema = z.object({
  incoming: z.array(incomingConnectRequestSchema),
  outgoing: z.array(outgoingConnectRequestSchema),
})
export type ConnectRequestsResponse = z.infer<typeof connectRequestsResponseSchema>

export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>
export type Invite = z.infer<typeof inviteSchema>
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>
export type Friend = z.infer<typeof friendSchema>
export type BlockRequest = z.infer<typeof blockRequestSchema>
export type Block = z.infer<typeof blockSchema>
export type BlocksResponse = z.infer<typeof blocksResponseSchema>
