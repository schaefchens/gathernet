import type {
  PushCategories,
  PushPayload,
  SubscribePushRequest,
  UpdatePushPrefsRequest,
} from '@gathernet/shared'
import { and, eq } from 'drizzle-orm'
import webpush from 'web-push'
import type { Db } from '../../db/index.ts'
import { communityChannels, groups, pushSubscriptions } from '../../db/schema.ts'

/** Constant target size (chars) for the JSON payload — padded so the push service
 *  can't infer the category from length. */
const PAYLOAD_TARGET = 320

/** Coalesce: at most one push per device per window — caps notification noise AND the
 *  timing signal a channel fan-out would otherwise leak to the push service. */
const COALESCE_MS = 60_000
const lastPush = new Map<string, number>()

let configured = false

/** Install the VAPID keypair once (called from buildApp). Idempotent. */
export function configureWebPush(cfg: {
  VAPID_SUBJECT: string
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY: string
}): void {
  webpush.setVapidDetails(cfg.VAPID_SUBJECT, cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY)
  configured = true
}

/** Build a constant-size, content-free push payload (category code only). */
export function buildPushPayload(
  category: PushPayload['category'],
  communityId?: string,
): PushPayload {
  const base: PushPayload = {
    v: 1,
    category,
    ...(communityId ? { communityId: communityId as PushPayload['communityId'] } : {}),
  }
  const pad = Math.max(0, PAYLOAD_TARGET - JSON.stringify({ ...base, pad: '' }).length)
  return { ...base, pad: 'x'.repeat(pad) }
}

/** Register/refresh this device's subscription (upsert by endpoint). */
export async function subscribePush(
  db: Db,
  accountId: string,
  deviceId: string,
  input: SubscribePushRequest,
): Promise<void> {
  const c = input.categories
  await db
    .insert(pushSubscriptions)
    .values({
      deviceId,
      accountId,
      endpoint: input.subscription.endpoint,
      p256dh: input.subscription.p256dh,
      auth: input.subscription.auth,
      ...(c ? { dmEnabled: c.dm, channelEnabled: c.channel, moderationEnabled: c.moderation } : {}),
      ...(input.mutedCommunityIds ? { mutedCommunityIds: input.mutedCommunityIds } : {}),
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        deviceId,
        accountId,
        p256dh: input.subscription.p256dh,
        auth: input.subscription.auth,
        ...(c
          ? { dmEnabled: c.dm, channelEnabled: c.channel, moderationEnabled: c.moderation }
          : {}),
        ...(input.mutedCommunityIds ? { mutedCommunityIds: input.mutedCommunityIds } : {}),
      },
    })
}

/** Update push prefs across all of this device's subscriptions. */
export async function updatePushPrefs(
  db: Db,
  deviceId: string,
  input: UpdatePushPrefsRequest,
): Promise<void> {
  const patch: Partial<typeof pushSubscriptions.$inferInsert> = {}
  if (input.categories) {
    patch.dmEnabled = input.categories.dm
    patch.channelEnabled = input.categories.channel
    patch.moderationEnabled = input.categories.moderation
  }
  if (input.mutedCommunityIds) patch.mutedCommunityIds = input.mutedCommunityIds
  await db.update(pushSubscriptions).set(patch).where(eq(pushSubscriptions.deviceId, deviceId))
}

/** Remove a specific endpoint for this device. */
export async function unsubscribePush(db: Db, deviceId: string, endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.deviceId, deviceId), eq(pushSubscriptions.endpoint, endpoint)))
}

function categoryEnabled(
  row: typeof pushSubscriptions.$inferSelect,
  category: PushPayload['category'],
): boolean {
  const map: PushCategories = {
    dm: row.dmEnabled,
    channel: row.channelEnabled,
    moderation: row.moderationEnabled,
  }
  return map[category]
}

/**
 * Send a push to every live subscription of a device, gated by that subscription's
 * server-side prefs (category enabled + community not muted). Dead subscriptions
 * (404/410 from the push service) are pruned. Never throws — best-effort.
 */
export async function sendToDevicePush(
  db: Db,
  deviceId: string,
  payload: PushPayload,
): Promise<void> {
  if (!configured) return
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.deviceId, deviceId))
  const body = JSON.stringify(payload)
  for (const row of rows) {
    if (!categoryEnabled(row, payload.category)) continue
    if (payload.communityId && row.mutedCommunityIds?.includes(payload.communityId)) continue
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
      )
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        // Subscription is gone — prune it.
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, row.id))
          .catch(() => {})
      }
      // Other errors (transient push-service failures) are swallowed — push is a
      // best-effort fallback, never a hard dependency of message delivery.
    }
  }
}

/** Push to a device only if it hasn't been pushed within the coalesce window. */
export async function coalescedPush(
  db: Db,
  deviceId: string,
  payload: PushPayload,
  now = Date.now(),
): Promise<void> {
  if (now - (lastPush.get(deviceId) ?? 0) < COALESCE_MS) return
  lastPush.set(deviceId, now)
  await sendToDevicePush(db, deviceId, payload)
}

/**
 * Fire an offline-fallback push for a new message. Categorizes the group (dm vs
 * community channel, with the channel's communityId for mute gating); rooms and
 * group_key channels are skipped. Caller passes the already-offline recipient
 * devices. Best-effort — never throws.
 */
export async function notifyMessageActivity(
  db: Db,
  groupId: string,
  offlineDeviceIds: string[],
): Promise<void> {
  if (!configured || offlineDeviceIds.length === 0) return
  const group = await db.query.groups.findFirst({ where: eq(groups.groupId, groupId) })
  if (!group) return
  let payload: PushPayload
  if (group.kind === 'dm') {
    payload = buildPushPayload('dm')
  } else if (group.kind === 'channel') {
    const channel = await db.query.communityChannels.findFirst({
      where: eq(communityChannels.channelId, groupId),
    })
    payload = buildPushPayload('channel', channel?.communityId)
  } else {
    return // rooms etc. — no push
  }
  await Promise.all(offlineDeviceIds.map((d) => coalescedPush(db, d, payload).catch(() => {})))
}
