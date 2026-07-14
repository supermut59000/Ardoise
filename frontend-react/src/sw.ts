/// <reference lib="webworker" />
/**
 * Custom service worker (vite-plugin-pwa `injectManifest`). Replaces the
 * generated one so we can handle Web Push; keeps the exact same precache +
 * SPA-fallback + prompt-update behaviour the generated SW had.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope &
  typeof globalThis & { __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0] }

// App shell precache; data is local-first (Dexie), so no runtime API caching.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')))

// Prompt-mode update flow: the page sends SKIP_WAITING when the user taps
// "Recharger" in the PwaPrompt toast (workbox-window messageSkipWaiting()).
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

interface PushPayload {
  title?: string
  body?: string
  groupId?: string
}

self.addEventListener('push', (event) => {
  // iOS requires every push to end in a visible notification; a swallowed
  // push gets the subscription silently revoked. So always show something.
  let data: PushPayload = {}
  try {
    data = (event.data?.json() as PushPayload) ?? {}
  } catch {
    /* non-JSON payload: show the generic notification */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Ardoise', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // One collapsed notification per group instead of a pile.
      tag: data.groupId ? `ardoise-${data.groupId}` : 'ardoise',
      data: { groupId: data.groupId ?? null },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const groupId = (event.notification.data as { groupId?: string | null } | undefined)?.groupId
  const url = groupId ? `/g/${groupId}` : '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = windows[0]
      if (existing) {
        await existing.focus()
        await existing.navigate(url)
      } else {
        await self.clients.openWindow(url)
      }
    })(),
  )
})
