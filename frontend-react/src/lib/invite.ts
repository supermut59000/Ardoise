export interface InviteCredentials {
  joinCode: string
  apiKey: string
}

/**
 * Put credentials in the URL fragment: browsers do not send it to Caddy,
 * nginx, or the backend, so the shared password stays out of access logs.
 */
export function buildAutomaticInvite(origin: string, joinCode: string, apiKey: string): string {
  const url = new URL('/', origin)
  url.hash = new URLSearchParams({ join: joinCode, key: apiKey }).toString()
  return url.toString()
}

/** Read an automatic invite. The caller must erase the fragment immediately. */
export function parseAutomaticInvite(hash: string): InviteCredentials | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const joinCode = params.get('join')?.trim() ?? ''
  const apiKey = params.get('key') ?? ''
  return joinCode ? { joinCode, apiKey } : null
}
