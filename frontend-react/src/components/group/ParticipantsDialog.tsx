import { useState } from 'react'
import { UserPlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { addMember, removeMember } from '@/sync/ops'
import type { Member } from '@/domain/types'

interface Props {
  groupId: string
  members: Member[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ParticipantsDialog({ groupId, members, open, onOpenChange }: Props) {
  const [name, setName] = useState('')

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await addMember(groupId, trimmed)
      setName('')
    } catch {
      toast.error("Impossible d'ajouter le participant")
    }
  }

  async function handleRemove(member: Member) {
    try {
      await removeMember(groupId, member.id)
      toast.success(`${member.name} retire`)
    } catch {
      toast.error('Suppression impossible')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Participants</DialogTitle>
        <DialogDescription>Ajoutez ou retirez les personnes du groupe.</DialogDescription>

        <ul className="space-y-1">
          {members.length === 0 && (
            <li className="text-sm text-muted-foreground">Aucun participant pour l'instant.</li>
          )}
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between rounded-md px-1 py-1.5">
              <span className="text-sm">{m.name}</span>
              <button
                onClick={() => handleRemove(m)}
                aria-label={`Retirer ${m.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={handleAdd} className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nom du participant"
            aria-label="Nom du participant"
            autoFocus
          />
          <Button type="submit" size="icon" disabled={!name.trim()} aria-label="Ajouter">
            <UserPlus className="size-5" />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
