import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { renameGroup } from '@/sync/ops'

interface Props {
  groupId: string
  currentName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RenameGroupDialog({ groupId, currentName, open, onOpenChange }: Props) {
  const [name, setName] = useState(currentName)

  useEffect(() => {
    if (open) setName(currentName)
  }, [open, currentName])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      if (trimmed !== currentName) await renameGroup(groupId, trimmed)
      onOpenChange(false)
    } catch {
      toast.error('Renommage impossible')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Renommer le groupe</DialogTitle>
        <DialogDescription>Le nouveau nom sera visible par tous les participants.</DialogDescription>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Nom du groupe"
            autoFocus
          />
          <Button type="submit" disabled={!name.trim()}>
            Renommer
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
