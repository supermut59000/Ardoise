/**
 * Ask the browser to keep our IndexedDB data from being evicted.
 * Critical on iOS, where unpersisted IndexedDB can be cleared after ~7 idle days.
 * Safe to call on every launch; the browser only prompts/persists once.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!("storage" in navigator) || !navigator.storage.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
