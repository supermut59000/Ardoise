import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { checkApiKey } from '@/sync/client'
import { getApiKey, notifyAuthSuccess, setApiKey } from '@/lib/auth'
import { syncAllGroups } from '@/sync/engine'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * One-time password gate. The key is validated against the server, then stored
 * permanently in localStorage and attached to every sync request thereafter.
 */
export function ApiKeyDialog({ open, onOpenChange }: Props) {
  const [value, setValue] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(false)
  const alreadySet = Boolean(getApiKey())

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const key = value.trim()
    if (!key) return
    setChecking(true)
    setError(false)
    const ok = await checkApiKey(key)
    setChecking(false)
    if (!ok) {
      setError(true)
      return
    }
    setApiKey(key)
    setValue('')
    onOpenChange(false)
    toast.success('Mot de passe enregistre')
    void syncAllGroups() // catch up now that we can authenticate
    notifyAuthSuccess() // and let the interrupted action (e.g. a join) retry
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-5" /> Mot de passe du serveur
        </DialogTitle>
        <DialogDescription>
          Ce serveur est protege. Saisissez le mot de passe une seule fois : il sera memorise sur cet appareil.
        </DialogDescription>

        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={alreadySet ? 'Nouveau mot de passe' : 'Mot de passe'}
            autoFocus
            aria-label="Mot de passe du serveur"
          />
          {error && <p className="text-sm text-destructive">Mot de passe incorrect ou serveur injoignable.</p>}
          <Button type="submit" className="w-full" disabled={checking || !value.trim()}>
            {checking ? 'Verification...' : 'Valider'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
