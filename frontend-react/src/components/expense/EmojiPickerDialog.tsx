import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { searchEmojis } from '@/lib/emoji'

interface Props {
  /** Currently selected emoji ('' = none). */
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (emoji: string) => void
}

export function EmojiPickerDialog({ value, open, onOpenChange, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const results = searchEmojis(query, 999)

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  function pick(emoji: string) {
    onSelect(emoji)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh]">
        <DialogTitle>Choisir un emoji</DialogTitle>
        <DialogDescription>Il s'affichera sur la depense pour la reconnaitre d'un coup d'oeil.</DialogDescription>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher : courses, resto, essence..."
          aria-label="Rechercher un emoji"
        />

        <div className="grid max-h-[45vh] grid-cols-6 gap-1 overflow-y-auto pr-1" role="listbox" aria-label="Emojis">
          {results.map((entry) => (
            <button
              type="button"
              key={entry.emoji}
              role="option"
              aria-selected={entry.emoji === value}
              aria-label={entry.keywords[0]}
              title={entry.keywords[0]}
              onClick={() => pick(entry.emoji)}
              className={`flex aspect-square cursor-pointer items-center justify-center rounded-lg text-2xl transition-colors hover:bg-accent ${entry.emoji === value ? 'bg-accent ring-2 ring-primary' : ''}`}
            >
              {entry.emoji}
            </button>
          ))}
          {results.length === 0 && (
            <p className="col-span-6 py-6 text-center text-sm text-muted-foreground">
              Aucun emoji trouve pour cette recherche.
            </p>
          )}
        </div>

        {value && (
          <Button type="button" variant="outline" onClick={() => pick('')}>
            Retirer l'emoji
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
