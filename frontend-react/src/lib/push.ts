/**
 * Web Push, per device. Reality check per platform:
 *  - Android/Chromium and desktop: full support.
 *  - iOS 16.4+: supported ONLY when the app is installed on the home screen
 *    (standalone). In Safari-the-tab, PushManager does not exist; the UI then
 *    points the user to the install instructions instead of a dead toggle.
 * The subscription is device-scoped, like identity ("Qui etes-vous ?"): it
 * never syncs through the op log. The server stores the endpoint plus the list
 * of shared groups this device follows, and notifies on group activity.
 */
import { db, getMeta } from '@/db/dexie'
import { getVapidPublicKey, subscribePush, unsubscribePush } from '@/sync/client'

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isPushDenied(): boolean {
  return 'Notification' in window && Notification.permission === 'denied'
}

/** applicationServerKey wants raw bytes; the server hands us base64url. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  try {
    return await (await registration()).pushManager.getSubscription()
  } catch {
    return null
  }
}

/** The shared groups this device follows (local-only groups never notify). */
async function sharedGroupIds(): Promise<string[]> {
  return (await db.syncState.toArray()).map((s) => s.groupId)
}

async function sendSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('subscription incomplete')
  }
  const { deviceId } = await getMeta()
  await subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    deviceId,
    groupIds: await sharedGroupIds(),
  })
}

/**
 * Enable notifications on this device. Must be called from a user gesture
 * (menu tap): iOS refuses permission requests outside one. Throws with a
 * French message the caller can toast.
 */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new Error('Notifications non disponibles sur cet appareil')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Autorisation refusee. Activez les notifications dans les reglages du navigateur.')
  }
  const { publicKey } = await getVapidPublicKey()
  const reg = await registration()
  // Re-subscribing while already subscribed returns the existing subscription.
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  })
  await sendSubscription(sub)
}

/** Disable notifications on this device (browser + server side). */
export async function disablePush(): Promise<void> {
  const sub = await getExistingSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  try {
    await unsubscribePush(endpoint)
  } catch {
    // Server unreachable: the dead endpoint will be pruned on its first 410.
  }
}

/**
 * Keep the server's group list in step with this device. Called on app start
 * and after share/join/leave. Silent no-op when not subscribed or offline
 * (the next call catches up).
 */
export async function syncPushGroups(): Promise<void> {
  try {
    const sub = await getExistingSubscription()
    if (sub) await sendSubscription(sub)
  } catch {
    /* opportunistic; never surfaces */
  }
}
