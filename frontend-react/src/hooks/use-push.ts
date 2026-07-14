import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { disablePush, enablePush, getExistingSubscription, isPushSupported } from '@/lib/push'
import { SyncError } from '@/sync/client'
import { promptForApiKey } from '@/lib/auth'

export type PushState = 'unsupported' | 'off' | 'on'

/**
 * Notification toggle state for this device. 'unsupported' covers real lack of
 * support AND iOS-in-Safari (where installing to the home screen unlocks it;
 * the menu handles that case separately via the install helper).
 */
export function usePush() {
  const [state, setState] = useState<PushState>('unsupported')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isPushSupported()) return
    let cancelled = false
    void getExistingSubscription().then((sub) => {
      if (!cancelled) setState(sub ? 'on' : 'off')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const enable = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await enablePush()
      setState('on')
      toast.success('Notifications activees sur cet appareil')
    } catch (e) {
      if (e instanceof SyncError && e.status === 401) {
        promptForApiKey()
      } else if (e instanceof SyncError && e.status === 503) {
        toast.error("Les notifications ne sont pas configurees sur ce serveur.")
      } else if (e instanceof SyncError) {
        toast.error('Serveur injoignable. Reessayez une fois en ligne.')
      } else {
        toast.error(e instanceof Error ? e.message : 'Activation impossible')
      }
    } finally {
      setBusy(false)
    }
  }, [busy])

  const disable = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await disablePush()
      setState('off')
      toast.success('Notifications desactivees sur cet appareil')
    } catch {
      toast.error('Desactivation impossible')
    } finally {
      setBusy(false)
    }
  }, [busy])

  return { state, busy, enable, disable }
}
