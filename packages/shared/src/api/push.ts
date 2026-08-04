import { z } from 'zod'
import { communityIdSchema } from '../ids.ts'

/**
 * Web Push — the PWA's only way to notify a closed app. The server sends only a
 * category code in a Web-Push-encrypted, constant-size payload (never message content,
 * names, or ciphertext). Per-category switches + community mutes live server-side
 * because `userVisibleOnly` forbids the service worker from silently dropping a push;
 * display prefs (generic vs coarse, custom title/icon) stay client-side.
 */

/** Which kinds of activity a device wants pushed. */
export const pushCategoriesSchema = z.object({
  dm: z.boolean(),
  channel: z.boolean(),
  moderation: z.boolean(),
})
export type PushCategories = z.infer<typeof pushCategoriesSchema>

/** The browser's PushSubscription (endpoint + keys), as the client hands it over. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  /** base64url subscription public key */
  p256dh: z.string().max(255),
  /** base64url subscription auth secret */
  auth: z.string().max(255),
})
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>

/** Register (or upsert) this device's subscription + initial prefs. */
export const subscribePushRequestSchema = z.object({
  subscription: pushSubscriptionSchema,
  categories: pushCategoriesSchema.optional(),
  mutedCommunityIds: z.array(communityIdSchema).max(1000).optional(),
})
export type SubscribePushRequest = z.infer<typeof subscribePushRequestSchema>

/** Update this device's push prefs (categories / mutes) without re-subscribing. */
export const updatePushPrefsRequestSchema = z
  .object({
    categories: pushCategoriesSchema.optional(),
    mutedCommunityIds: z.array(communityIdSchema).max(1000).optional(),
  })
  .refine((v) => v.categories !== undefined || v.mutedCommunityIds !== undefined, {
    message: 'no prefs to update',
  })
export type UpdatePushPrefsRequest = z.infer<typeof updatePushPrefsRequestSchema>

/** Unsubscribe a specific endpoint (device may hold several across reinstalls). */
export const unsubscribePushRequestSchema = z.object({
  endpoint: z.string().url().max(2048),
})
export type UnsubscribePushRequest = z.infer<typeof unsubscribePushRequestSchema>

export const vapidKeyResponseSchema = z.object({ publicKey: z.string() })
export type VapidKeyResponse = z.infer<typeof vapidKeyResponseSchema>

/** The (encrypted, padded) payload the SW receives — a category code only. */
export const pushPayloadSchema = z.object({
  v: z.literal(1),
  category: z.enum(['dm', 'channel', 'moderation']),
  communityId: communityIdSchema.optional(),
  /** random padding so every push is a constant size to the push service */
  pad: z.string().optional(),
})
export type PushPayload = z.infer<typeof pushPayloadSchema>
