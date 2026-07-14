import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { countUnsyncedFor, leaveGroup } from '@/sync/engine'
import { setMe } from '@/lib/me'
import { syncPushGroups } from '@/lib/push'

interface Props {
  groupId: string
  groupName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Leave a SHARED group on this device only: the other participants keep it, and
 * re-joining with the share code restores it in full. This is the safe way for
 * a friend to declutter their list (deleting would remove it for everyone).
 */
export function LeaveGroupDialog({ groupId, groupName, open, onOpenChange }: Props) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(0)
  const [leaving, setLeaving] = useState(false)

  // Warn when local changes have not reached the server yet: they would be lost.
  useEffect(() => {
    if (!open) return
    countUnsyncedFor(groupId)
      .then(setPending)
      .catch(() => setPending(0))
  }, [open, groupId])

  async function handleLeave() {
    setLeaving(true)
    try {
      await leaveGroup(groupId)
      setMe(groupId, null)
      void syncPushGroups() // stop being notified about the group we left
      onOpenChange(false)
      navigate('/')
      toast.success(`Vous avez quitte "${groupName}"`)
    } catch {
      toast.error('Impossible de quitter le groupe')
      setLeaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Quitter le groupe ?</DialogTitle>
        <DialogDescription>
          {`"${groupName}" sera retire de cet appareil seulement. Les autres participants le conservent, et vous pourrez le retrouver en le rejoignant avec son code de partage.`}
        </DialogDescription>
        {pending > 0 && (
          <p className="text-sm text-destructive">
            {pending} modification{pending > 1 ? 's' : ''} pas encore synchronisee{pending > 1 ? 's' : ''} sera{pending > 1 ? 'ont' : ''} perdue{pending > 1 ? 's' : ''}. Repassez en ligne d'abord si vous voulez les garder.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button variant="destructive" disabled={leaving} onClick={handleLeave}>
            Quitter
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
