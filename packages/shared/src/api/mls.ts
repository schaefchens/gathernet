import { z } from 'zod'
import { accountIdSchema, deviceIdSchema, groupIdSchema } from '../ids.ts'

/** hex-encoded key package ref (opaque, from the MLS client) */
const kpRefSchema = z.string().regex(/^[0-9a-f]{2,128}$/)

export const uploadKeyPackagesRequestSchema = z.object({
  keyPackages: z
    .array(
      z.object({
        ref: kpRefSchema,
        data: z.base64(),
        isLastResort: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100),
})

export const claimKeyPackagesRequestSchema = z.object({
  /** claim one KP per active device of each account (excluding the caller's device) */
  accountIds: z.array(accountIdSchema).min(1).max(10),
})

export const claimedKeyPackageSchema = z.object({
  accountId: accountIdSchema,
  deviceId: deviceIdSchema,
  ref: z.string(),
  data: z.base64(),
})

export const claimKeyPackagesResponseSchema = z.object({
  keyPackages: z.array(claimedKeyPackageSchema),
})

export const groupSummarySchema = z.object({
  groupId: groupIdSchema,
  kind: z.literal('dm'),
  friendAccountId: accountIdSchema,
  /** true if this account's side must create/populate the MLS group */
  creator: z.boolean(),
  currentEpoch: z.number().int(),
  /** base64 latest GroupInfo (with ratchet tree) — null until the first commit */
  groupInfo: z.base64().nullable(),
  /** device is already a leaf (has processed Welcome or external-joined) */
  isMember: z.boolean(),
})

export const groupsResponseSchema = z.object({
  groups: z.array(groupSummarySchema),
})

export const postCommitRequestSchema = z.object({
  /** epoch the commit was built at — must equal the group's current epoch */
  epoch: z.number().int().nonnegative(),
  commit: z.base64(),
  /** GroupInfo AFTER this commit, with ratchet tree — mandatory */
  groupInfo: z.base64(),
  welcomes: z
    .array(
      z.object({
        deviceId: deviceIdSchema,
        payload: z.base64(),
      }),
    )
    .default([]),
  memberChanges: z
    .object({
      adds: z.array(deviceIdSchema).default([]),
      removes: z.array(deviceIdSchema).default([]),
    })
    .default({ adds: [], removes: [] }),
})

export const postCommitResponseSchema = z.object({
  seq: z.number().int(),
  newEpoch: z.number().int(),
})

export const mailboxMessageSchema = z.object({
  groupId: groupIdSchema,
  seq: z.number().int(),
  kind: z.enum(['application', 'commit', 'proposal']),
  epoch: z.number().int(),
  senderDevice: deviceIdSchema,
  payload: z.base64(),
  sentAt: z.number().int(),
})

export const messagesResponseSchema = z.object({
  messages: z.array(mailboxMessageSchema),
})

export const pendingWelcomeSchema = z.object({
  welcomeId: z.number().int(),
  groupId: groupIdSchema,
  payload: z.base64(),
})

export const welcomesResponseSchema = z.object({
  welcomes: z.array(pendingWelcomeSchema),
})

export type UploadKeyPackagesRequest = z.infer<typeof uploadKeyPackagesRequestSchema>
export type ClaimKeyPackagesRequest = z.infer<typeof claimKeyPackagesRequestSchema>
export type ClaimedKeyPackage = z.infer<typeof claimedKeyPackageSchema>
export type GroupSummary = z.infer<typeof groupSummarySchema>
export type PostCommitRequest = z.infer<typeof postCommitRequestSchema>
export type MailboxMessage = z.infer<typeof mailboxMessageSchema>
export type PendingWelcome = z.infer<typeof pendingWelcomeSchema>
