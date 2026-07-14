import { useSyncExternalStore } from 'react'

/**
 * "Who am I in this group" (member id), device-local and never synced:
 * identity is a property of the device, not of the shared data. Used to
 * preselect the payer and to show a personal balance headline.
 */
const KEY = 'ardoise-me'
const EVENT = 'ardoise:me-changed'

function readAll(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export function getMe(groupId: string): string | null {
  return readAll()[groupId] ?? null
}

export function setMe(groupId: string, memberId: string | null): void {
  const all = readAll()
  if (memberId) all[groupId] = memberId
  else delete all[groupId]
  localStorage.setItem(KEY, JSON.stringify(all))
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

/** Reactive version of getMe for components. */
export function useMe(groupId: string): string | null {
  return useSyncExternalStore(subscribe, () => getMe(groupId))
}
