/// <reference lib="webworker" />
/**
 * Custom service worker (injectManifest). Keeps the app-shell precache + SPA
 * navigation fallback that generateSW gave us for free, and adds the Web Push
 * handler. The push payload is a content-free category code (see modules/push);
 * the SW composes the visible notification from LOCAL display prefs read from
 * IndexedDB — so it works while the app is locked (no DMK, no network).
 */
import type { PushPayload } from '@gathernet/shared'
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import type { PushDisplayPrefs } from './lib/storage.ts'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string }> }

// App shell (incl. wasm) — offline unlock + history must work with no network.
precacheAndRoute(self.__WB_MANIFEST)
// SPA fallback: serve index.html for navigations, except the API/WS/health paths.
// In dev the manifest is empty, so index.html isn't precached and
// createHandlerBoundToURL throws — which would kill the whole SW (and with it push).
// Guard it: without a precached shell, navigations just hit the network (the dev
// server serves index.html anyway); push handlers below still register.
try {
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL('index.html'), {
      denylist: [/^\/api\//, /^\/ws/, /^\/healthz/],
    }),
  )
} catch {
  // No precached app shell (dev) — skip the offline navigation fallback.
}

// Prompt-to-update flow (registerType: 'prompt'): the page posts SKIP_WAITING.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

const STRINGS = {
  en: {
    generic: 'New activity',
    dm: 'New message',
    channel: 'New message in a community',
    moderation: 'Something needs your review',
    event: 'Upcoming event',
  },
  de: {
    generic: 'Neue Aktivität',
    dm: 'Neue Nachricht',
    channel: 'Neue Nachricht in einer Gemeinschaft',
    moderation: 'Etwas benötigt deine Prüfung',
    event: 'Bevorstehendes Treffen',
  },
} satisfies Record<'en' | 'de', Record<PushPayload['category'] | 'generic', string>>

/** Read display prefs from the app's IndexedDB (plaintext `meta`/`push`). Version-less
 *  open so the SW never triggers an upgrade; missing → undefined (defaults apply). */
function readPushPrefs(): Promise<PushDisplayPrefs | undefined> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open('gathernet')
    } catch {
      resolve(undefined)
      return
    }
    req.onerror = () => resolve(undefined)
    req.onsuccess = () => {
      const db = req.result
      try {
        const get = db.transaction('meta', 'readonly').objectStore('meta').get('push')
        get.onsuccess = () => resolve(get.result as PushDisplayPrefs | undefined)
        get.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    }
  })
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload: PushPayload | null = null
      try {
        payload = event.data?.json() as PushPayload
      } catch {
        payload = null
      }
      if (payload?.v !== 1) return
      const prefs = await readPushPrefs()
      const s = prefs?.locale?.startsWith('de') ? STRINGS.de : STRINGS.en
      const body = prefs?.contentLevel === 'generic' ? s.generic : s[payload.category]
      await self.registration.showNotification(prefs?.title || 'Gathernet', {
        body,
        icon: prefs?.icon || '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: payload.category,
        data: { category: payload.category, communityId: payload.communityId },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = clientsArr.find((c) => 'focus' in c)
      if (existing) {
        await (existing as WindowClient).focus()
        return
      }
      await self.clients.openWindow('/')
    })(),
  )
})
