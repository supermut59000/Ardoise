import { useEffect, useRef, useState } from 'react'
import { countUnsyncedShared, syncAllGroups } from '@/sync/engine'
import { LOCAL_CHANGE_EVENT } from '@/sync/events'
import { promptForApiKey } from '@/lib/auth'

/**
 * Drives opportunistic sync. iOS has no reliable Background Sync, so we sync
 * while the app is open: on mount, on reconnect, when the tab becomes visible,
 * on a light interval, and (the fast path) right after a local change so edits
 * reach friends in about a second. Never blocks the UI.
 *
 * `pending` = local changes not yet on the server, so the UI can show a quiet
 * indicator instead of silently failing. A persistent password failure opens the
 * key dialog (throttled) rather than surfacing a raw error.
 */
export function useSync() {
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const [pending, setPending] = useState(0)
  const running = useRef(false)
  const lastAuthPrompt = useRef(0)

  const refreshPending = useRef(async () => {
    try {
      setPending(await countUnsyncedShared())
    } catch {
      /* ignore */
    }
  })

  const runRef = useRef(async () => {
    if (running.current || !navigator.onLine) {
      await refreshPending.current()
      return
    }
    running.current = true
    setSyncing(true)
    try {
      const { authError } = await syncAllGroups()
      // Prompt for the password at most once a minute, only on a real 401.
      if (authError && Date.now() - lastAuthPrompt.current > 60_000) {
        lastAuthPrompt.current = Date.now()
        promptForApiKey()
      }
    } finally {
      running.current = false
      setSyncing(false)
      await refreshPending.current()
    }
  })

  useEffect(() => {
    const trigger = () => void runRef.current()
    const onOnline = () => {
      setOnline(true)
      trigger()
    }
    const onOffline = () => setOnline(false)
    const onVisible = () => {
      if (document.visibilityState === 'visible') trigger()
    }
    let debounce: number | undefined
    const onLocalChange = () => {
      void refreshPending.current() // reflect the new pending change immediately
      window.clearTimeout(debounce)
      debounce = window.setTimeout(trigger, 800) // then push it promptly
    }

    trigger()
    void refreshPending.current()
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange)
    const id = window.setInterval(trigger, 20_000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange)
      window.clearInterval(id)
      window.clearTimeout(debounce)
    }
  }, [])

  return { online, syncing, pending }
}
