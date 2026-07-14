const STORAGE_KEY = 'ardoise_api_key'

/** Event fired when a request is rejected for a missing/invalid password, so a
 *  top-level listener can open the key dialog. */
export const AUTH_REQUIRED_EVENT = 'ardoise:auth-required'

/** The shared server password, stored permanently in the browser once entered. */
export function getApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key)
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** Ask the app to open the password dialog. */
export function promptForApiKey(): void {
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
}
