/**
 * Client-side Web Push: subscribe/unsubscribe against the push service + our server,
 * and manage the local DISPLAY prefs the service worker reads. The server only ever
 * sends a content-free category code; how it's shown is decided here + in sw.ts.
 */

import type { PushCategories, VapidKeyResponse } from '@gathernet/shared'
import { api } from './api.ts'
import { type PushDisplayPrefs, pushPrefsStore } from './storage.ts'

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** VAPID keys are base64url; PushManager wants a Uint8Array. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export interface PushState {
  supported: boolean
  permission: NotificationPermission
  subscribed: boolean
}

export async function getPushState(): Promise<PushState> {
  const supported = isPushSupported()
  if (!supported) return { supported: false, permission: 'denied', subscribed: false }
  // Don't block mount if the SW never becomes ready.
  const reg = await swRegistration().catch(() => null)
  const sub = reg ? await reg.pushManager.getSubscription() : null
  return { supported: true, permission: Notification.permission, subscribed: !!sub }
}

/** Resolve the active service-worker registration, but never hang forever — if the SW
 *  isn't ready (e.g. the page hasn't picked it up), throw a clear, surfaced error. */
async function swRegistration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('service worker not ready — reload the app and retry')),
      8000,
    ),
  )
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

/** Request permission, subscribe with the server's VAPID key, and register the
 *  subscription server-side. Returns false if permission was refused; throws (with a
 *  human message) on any other failure so the UI can show it. */
export async function enablePush(): Promise<boolean> {
  if (!isPushSupported()) return false
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const reg = await swRegistration()
  const { publicKey } = await api<VapidKeyResponse>('GET', '/api/v1/push/vapid-key')
  // Reuse an existing subscription if present (re-subscribing with the same key would
  // otherwise be a no-op; a different key throws InvalidStateError).
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }))
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('push subscription missing keys')
  }
  await api('POST', '/api/v1/push/subscriptions', {
    subscription: { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
  })
  // Seed default display prefs if none exist yet.
  if (!(await pushPrefsStore.get())) {
    await pushPrefsStore.put({ contentLevel: 'coarse', locale: getLocale() })
  }
  return true
}

/** Unsubscribe from the push service and drop the server-side subscription. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe().catch(() => {})
  await api('DELETE', '/api/v1/push/subscriptions', { endpoint }).catch(() => {})
}

/** Server-side pref update (which categories to push / muted communities). */
export async function updateServerPushPrefs(input: {
  categories?: PushCategories
  mutedCommunityIds?: string[]
}): Promise<void> {
  await api('PATCH', '/api/v1/push/subscriptions', input)
}

/* ---------- local display prefs (SW-readable) ---------- */

function getLocale(): string {
  return localStorage.getItem('gn.lang') ?? 'en'
}

export async function getDisplayPrefs(): Promise<PushDisplayPrefs> {
  return (await pushPrefsStore.get()) ?? { contentLevel: 'coarse', locale: getLocale() }
}

export async function setDisplayPrefs(patch: {
  contentLevel?: 'coarse' | 'generic'
  title?: string | undefined
  icon?: string | undefined
  locale?: string
}): Promise<void> {
  const cur = await getDisplayPrefs()
  const next: PushDisplayPrefs = {
    contentLevel: patch.contentLevel ?? cur.contentLevel,
    locale: patch.locale ?? cur.locale ?? getLocale(),
  }
  // title/icon are clearable: only carry them forward when truthy (empty/undefined = clear).
  const title = 'title' in patch ? patch.title : cur.title
  const icon = 'icon' in patch ? patch.icon : cur.icon
  if (title) next.title = title
  if (icon) next.icon = icon
  await pushPrefsStore.put(next)
}
