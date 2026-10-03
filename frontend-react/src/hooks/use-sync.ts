import { useEffect, useRef, useState } from 'react'
import { db } from '@/db/dexie'
import * as client from '@/sync/client'
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
  // One live SSE stream per shared group (wake-up -> sync pass). The stream
  // map lives in the effect below; the ref bridges it to the sync pass, which
  // reconciles it after every run. The 20s polling stays as the fallback.
  const reconcileStreams = useRef<() => void>(() => {})

  const refreshPending = useRef(async () => {
    try {
      setPending(await countUnsyncedShared())
    } catch {
      /* ignore */
    }
  })

  const runRef = useRef(async () => {
    // Note: no navigator.onLine gate. It reports the link, not the server, and
    // some WebViews misreport offline; attempting the sync and letting the
    // fetch fail fast is more reliable. `online` only drives the status bar.
    if (running.current) {
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
      reconcileStreams.current()
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

    // Live wake-up: ONE SSE stream for ALL shared groups (Rust endpoint
    // /groups/events) — a user in G groups holds 1 connection instead of G.
    // On `event: op` the stream has told us something landed on the server,
    // so run the normal sync pass (the wake-up carries no data, and the pass
    // covers every group). If the backend has no multi endpoint (Python:
    // 404), fall back for the session to one stream per group. On stream end,
    // reconnect with exponential backoff (1s -> 30s); the 20s polling below
    // covers any gap.
    let multi: AbortController | null = null
    let multiKey = ''
    let perGroupMode = false
    const streams = new Map<string, AbortController>()
    const streamLoop = (gid: string, ac: AbortController) => {
      let delay = 1_000
      void (async () => {
        while (!ac.signal.aborted) {
          try {
            await client.openEventStream(gid, () => trigger(), ac.signal)
            delay = 1_000 // clean close (server restart): retry promptly
          } catch {
            if (ac.signal.aborted) return
          }
          if (ac.signal.aborted) return
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 2, 30_000)
        }
      })()
    }
    const reconcilePerGroup = (ids: Set<string>) => {
      for (const [gid, ac] of streams) {
        if (!ids.has(gid)) {
          ac.abort() // left/deleted the group: drop its stream
          streams.delete(gid)
        }
      }
      for (const gid of ids) {
        if (streams.has(gid)) continue
        const ac = new AbortController()
        streams.set(gid, ac)
        streamLoop(gid, ac)
      }
    }
    const openMulti = (ids: string[]) => {
      const ac = new AbortController()
      multi = ac
      let delay = 1_000
      void (async () => {
        while (!ac.signal.aborted) {
          try {
            await client.openGroupEventStreams(ids, () => trigger(), ac.signal)
            delay = 1_000 // clean close (server restart): retry promptly
          } catch (e) {
            if (ac.signal.aborted) return
            if (e instanceof client.SyncError && e.status === 404) {
              // Backend without the multi endpoint (Python): per-group mode
              // for the rest of the session.
              perGroupMode = true
              multi = null
              multiKey = ''
              reconcilePerGroup(new Set(ids))
              return
            }
          }
          if (ac.signal.aborted) return
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 2, 30_000)
        }
      })()
    }
    reconcileStreams.current = async () => {
      let states: { groupId: string }[]
      try {
        states = await db.syncState.toArray()
      } catch {
        return
      }
      const ids = new Set(states.map((s) => s.groupId))
      if (perGroupMode) {
        reconcilePerGroup(ids)
        return
      }
      const key = [...ids].sort().join(',')
      if (key === multiKey) return
      multiKey = key
      multi?.abort()
      multi = null
      if (!key) return
      openMulti(key.split(','))
    }

    trigger()
    void refreshPending.current()
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange)
    const id = window.setInterval(trigger, 20_000)
    return () => {
      multi?.abort()
      for (const ac of streams.values()) ac.abort()
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
