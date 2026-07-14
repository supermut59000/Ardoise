import { useState } from 'react'
import { UserPlus, Trash2, Pencil, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { MemberAvatar } from '@/components/ui/member-avatar'
import { addMember, removeMember, renameMember } from '@/sync/ops'
import { setMe, useMe } from '@/lib/me'
import type { Member } from '@/domain/types'

interface Props {
  groupId: string
  members: Member[]
  /** Member ids that appear in a depense/remboursement and cannot be removed yet. */
  referenced: Set<string>
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ParticipantsDialog({ groupId, members, referenced, open, onOpenChange }: Props) {
  const me = useMe(groupId)
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

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

  function startEdit(member: Member) {
    setEditingId(member.id)
    setEditName(member.name)
  }

  async function handleRename(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = editName.trim()
    if (!editingId || !trimmed) return
    try {
      await renameMember(groupId, editingId, trimmed)
      setEditingId(null)
    } catch {
      toast.error('Renommage impossible')
    }
  }

  async function handleRemove(member: Member) {
    if (referenced.has(member.id)) {
      toast.error(`${member.name} figure dans des depenses. Retirez-les d'abord.`)
      return
    }
    try {
      await removeMember(groupId, member.id)
      if (me === member.id) setMe(groupId, null)
      toast.success(`${member.name} retire`)
    } catch {
      toast.error('Suppression impossible')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Participants</DialogTitle>
        <DialogDescription>Ajoutez, renommez ou retirez les personnes du groupe.</DialogDescription>

        <ul className="space-y-1">
          {members.length === 0 && (
            <li className="text-sm text-muted-foreground">Aucun participant pour l'instant.</li>
          )}
          {members.map((m) => {
            const locked = referenced.has(m.id)
            if (editingId === m.id) {
              return (
                <li key={m.id}>
                  <form onSubmit={handleRename} className="flex items-center gap-2 rounded-md px-1 py-1.5">
                    <MemberAvatar name={m.name} seed={m.id} size="sm" />
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      aria-label={`Nouveau nom de ${m.name}`}
                      className="h-9 flex-1"
                      autoFocus
                    />
                    <Button type="submit" size="icon" className="size-9" disabled={!editName.trim()} aria-label="Valider le nom">
                      <Check className="size-4" />
                    </Button>
                  </form>
                </li>
              )
            }
            return (
              <li key={m.id} className="flex items-center gap-2 rounded-md px-1 py-1.5">
                <MemberAvatar name={m.name} seed={m.id} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {m.name}
                  {me === m.id && <span className="text-muted-foreground"> (moi)</span>}
                </span>
                <button
                  onClick={() => startEdit(m)}
                  aria-label={`Renommer ${m.name}`}
                  title="Renommer"
                  className="cursor-pointer p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  onClick={() => handleRemove(m)}
                  aria-label={locked ? `${m.name} figure dans des depenses` : `Retirer ${m.name}`}
                  title={locked ? 'Figure dans des depenses' : 'Retirer'}
                  className={`p-1.5 transition-colors ${locked ? 'cursor-not-allowed text-muted-foreground/40' : 'cursor-pointer text-muted-foreground hover:text-destructive'}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            )
          })}
        </ul>

        <form onSubmit={handleAdd} className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nom du participant"
            aria-label="Nom du participant"
          />
          <Button type="submit" size="icon" disabled={!name.trim()} aria-label="Ajouter">
            <UserPlus className="size-5" />
          </Button>
        </form>

        {members.length > 0 && (
          <div className="space-y-1.5 border-t pt-3">
            <label htmlFor="whoami" className="text-sm font-medium">
              Qui etes-vous ?
            </label>
            <Select
              id="whoami"
              value={me ?? ''}
              onChange={(e) => setMe(groupId, e.target.value || null)}
              className="h-10 text-sm"
            >
              <option value="">Choisir mon nom...</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              Preremplit qui a paye et affiche votre solde en haut de l'onglet Soldes.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
