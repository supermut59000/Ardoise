import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { deleteGroup } from '@/sync/ops'
import { isShared } from '@/sync/engine'

interface Props {
  groupId: string
  groupName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteGroupDialog({ groupId, groupName, open, onOpenChange }: Props) {
  const navigate = useNavigate()
  const [shared, setShared] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // The warning differs: deleting a shared group propagates to everyone.
  useEffect(() => {
    if (!open) return
    isShared(groupId)
      .then(setShared)
      .catch(() => setShared(false))
  }, [open, groupId])

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteGroup(groupId)
      onOpenChange(false)
      navigate('/')
      toast.success(`Groupe "${groupName}" supprime`)
    } catch {
      toast.error('Suppression impossible')
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Supprimer le groupe ?</DialogTitle>
        <DialogDescription>
          {shared
            ? `"${groupName}" est partage : il sera supprime pour tous les participants, avec toutes ses depenses.`
            : `"${groupName}" et toutes ses depenses seront supprimes.`}
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button variant="destructive" disabled={deleting} onClick={handleDelete}>
            Supprimer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
