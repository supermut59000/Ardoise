import { useEffect, useRef, useState } from 'react'
import { syncAllGroups } from '@/sync/engine'

/**
 * Drives opportunistic sync. iOS has no reliable Background Sync, so we sync
 * while the app is open: on mount, on reconnect, when the tab becomes visible,
 * and on a light interval. Never blocks the UI; a run is skipped if one is
 * already in flight or we are offline.
 */
export function useSync() {
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const running = useRef(false)

  const runRef = useRef(async () => {
    if (running.current || !navigator.onLine) return
    running.current = true
    setSyncing(true)
    try {
      await syncAllGroups()
    } finally {
      running.current = false
      setSyncing(false)
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

    trigger()
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    const id = window.setInterval(trigger, 30_000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(id)
    }
  }, [])

  return { online, syncing }
}
