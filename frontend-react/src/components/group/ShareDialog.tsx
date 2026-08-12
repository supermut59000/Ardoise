import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, Check, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { shareGroup } from '@/sync/engine'
import { SyncError } from '@/sync/client'
import { AUTH_SUCCESS_EVENT, getApiKey, promptForApiKey } from '@/lib/auth'
import { buildAutomaticInvite } from '@/lib/invite'
import { syncPushGroups } from '@/lib/push'

interface Props {
  groupId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShareDialog({ groupId, open, onOpenChange }: Props) {
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)
  const [retryAfterAuth, setRetryAfterAuth] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')

  // Resume the exact share action that opened the password dialog. Unlike an
  // ordinary sync pass, a not-yet-shared group has no syncState row to retry.
  useEffect(() => {
    const retry = () => {
      if (retryAfterAuth) {
        setRetryAfterAuth(false)
        onOpenChange(true)
      }
    }
    window.addEventListener(AUTH_SUCCESS_EVENT, retry)
    return () => window.removeEventListener(AUTH_SUCCESS_EVENT, retry)
  }, [retryAfterAuth, onOpenChange])

  useEffect(() => {
    if (!open) return
    setError(false)
    setCode(null)
    setCopied(null)
    setLoading(true)
    // Registering is idempotent: opening this again returns the same code.
    shareGroup(groupId)
      .then((c) => {
        setCode(c)
        void syncPushGroups() // the group is now shared: follow its notifications
      })
      .catch((e) => {
        // Needs the shared password? Open the key dialog instead of a dead error.
        if (e instanceof SyncError && e.status === 401) {
          setRetryAfterAuth(true)
          onOpenChange(false)
          promptForApiKey()
        } else {
          setError(true)
        }
      })
      .finally(() => setLoading(false))
  }, [open, groupId, onOpenChange])

  const link = code ? `${window.location.origin}/?join=${code}` : ''
  const apiKey = getApiKey() ?? ''
  const automaticLink = code ? buildAutomaticInvite(window.location.origin, code, apiKey) : ''

  useEffect(() => {
    if (!automaticLink) {
      setQrDataUrl('')
      return
    }
    let cancelled = false
    void QRCode.toDataURL(automaticLink, { width: 256, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('')
      })
    return () => {
      cancelled = true
    }
  }, [automaticLink])

  async function copy(text: string, which: 'code' | 'link') {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      toast.success('Copie')
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error('Copie impossible')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Partager le groupe</DialogTitle>
        <DialogDescription>
          Donnez ce code (ou le lien) a une autre personne pour qu'elle rejoigne et synchronise ce groupe.
        </DialogDescription>

        {loading && <p className="text-sm text-muted-foreground">Enregistrement...</p>}

        {error && (
          <p className="text-sm text-destructive">
            Connexion au serveur requise pour partager. Reessayez une fois en ligne.
          </p>
        )}

        {code && (
          <div className="space-y-3">
            <button
              onClick={() => copy(code, 'code')}
              className="flex w-full cursor-pointer items-center justify-between rounded-lg border bg-muted px-4 py-3 transition-colors hover:bg-muted/70"
            >
              <span className="font-mono text-2xl tracking-widest">{code}</span>
              {copied === 'code' ? <Check className="size-5 text-emerald-500" /> : <Copy className="size-5 text-muted-foreground" />}
            </button>

            <Button variant="outline" className="w-full" onClick={() => copy(link, 'link')}>
              {copied === 'link' ? <Check className="size-4" /> : <Link2 className="size-4" />}
              Copier le lien d'invitation
            </Button>

            {qrDataUrl && (
              <div className="space-y-2 border-t pt-3 text-center">
                <p className="text-sm font-medium">Connexion automatique par QR code</p>
                <img
                  src={qrDataUrl}
                  alt="QR code pour rejoindre le groupe"
                  className="mx-auto size-56 rounded-lg bg-white p-2"
                />
                <p className="text-xs text-muted-foreground text-balance">
                  {apiKey
                    ? "Ce QR contient le code du groupe et le mot de passe du serveur. Montrez-le uniquement aux personnes de confiance."
                    : "Ce QR contient le code du groupe. Aucun mot de passe serveur n'est configure sur cet appareil."}
                </p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
