import { useEffect, useRef } from 'react'
import { parseAutomaticInvite } from '@/lib/invite'
import { setApiKey } from '@/lib/auth'

/**
 * Auto-join from an invite carried by the URL, and erase the credentials from
 * the address bar. Two shapes:
 *  - QR invites put the join code AND the shared server password in the URL
 *    fragment (#join=...&key=...), which browsers never send to Caddy/nginx;
 *  - legacy plain links use ?join=CODE.
 *
 * Runs on mount AND on `hashchange`: a same-tab navigation to /#join=... (no
 * page reload, e.g. tapping a link while the app is already open) used to leave
 * the password in the address bar and never join. The fragment is consumed at
 * most once per session.
 */
export function useAutomaticInvite(join: (code: string) => void): void {
  const joinRef = useRef(join)
  joinRef.current = join
  const autoJoined = useRef(false)

  useEffect(() => {
    const consume = () => {
      const automatic = parseAutomaticInvite(window.location.hash)
      const code = automatic?.joinCode ?? new URLSearchParams(window.location.search).get('join')
      if (!code || autoJoined.current) return
      autoJoined.current = true
      if (automatic?.apiKey) setApiKey(automatic.apiKey)
      // Drop the credentials (fragment and/or query) before contacting the
      // server, so they never linger in the address bar or in history.
      window.history.replaceState(null, '', window.location.pathname)
      joinRef.current(code)
    }
    consume()
    window.addEventListener('hashchange', consume)
    return () => window.removeEventListener('hashchange', consume)
  }, [])
}
