import { useEffect, useState } from 'react'
import { Copy, Check, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { shareGroup } from '@/sync/engine'
import { SyncError } from '@/sync/client'
import { promptForApiKey } from '@/lib/auth'

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

  useEffect(() => {
    if (!open) return
    setError(false)
    setCode(null)
    setCopied(null)
    setLoading(true)
    // Registering is idempotent: opening this again returns the same code.
    shareGroup(groupId)
      .then(setCode)
      .catch((e) => {
        // Needs the shared password? Open the key dialog instead of a dead error.
        if (e instanceof SyncError && e.status === 401) {
          onOpenChange(false)
          promptForApiKey()
        } else {
          setError(true)
        }
      })
      .finally(() => setLoading(false))
  }, [open, groupId, onOpenChange])

  const link = code ? `${window.location.origin}/?join=${code}` : ''

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
              className="flex w-full items-center justify-between rounded-lg border bg-muted px-4 py-3"
            >
              <span className="font-mono text-2xl tracking-widest">{code}</span>
              {copied === 'code' ? <Check className="size-5 text-emerald-500" /> : <Copy className="size-5 text-muted-foreground" />}
            </button>

            <Button variant="outline" className="w-full" onClick={() => copy(link, 'link')}>
              {copied === 'link' ? <Check className="size-4" /> : <Link2 className="size-4" />}
              Copier le lien d'invitation
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
