import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BrandMark } from '@/components/ui/brand-mark'
import { searchEmojis } from '@/lib/emoji'
import { searchBrands } from '@/lib/brands'

interface Props {
  /** Currently selected emoji ('' = none). */
  value: string
  /** Currently selected brand id ('' = none). */
  brand: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Picking an emoji clears the brand; picking a brand carries its emoji along. */
  onSelect: (emoji: string, brand: string) => void
}

export function EmojiPickerDialog({ value, brand, open, onOpenChange, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const results = searchEmojis(query, 999)
  const brands = searchBrands(query)

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  function pick(emoji: string, brandId: string) {
    onSelect(emoji, brandId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh]">
        <DialogTitle>Choisir une icone</DialogTitle>
        <DialogDescription>
          Elle s'affichera sur la depense pour la reconnaitre d'un coup d'oeil. Tapez une enseigne
          pour son logo.
        </DialogDescription>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher : carrefour, resto, essence..."
          aria-label="Rechercher une icone"
        />

        {/* Brands first: they are the precise answer when the query names one. */}
        {brands.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Enseignes</p>
            <div className="flex flex-wrap gap-1.5" role="listbox" aria-label="Enseignes">
              {brands.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  role="option"
                  aria-selected={entry.id === brand}
                  onClick={() => pick(entry.emoji, entry.id)}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-sm transition-colors hover:bg-accent ${entry.id === brand ? 'bg-accent ring-2 ring-primary' : ''}`}
                >
                  <BrandMark brand={entry} size="sm" />
                  <span className="pr-1">{entry.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid max-h-[45vh] grid-cols-6 gap-1 overflow-y-auto pr-1" role="listbox" aria-label="Emojis">
          {results.map((entry) => (
            <button
              type="button"
              key={entry.emoji}
              role="option"
              aria-selected={entry.emoji === value && !brand}
              aria-label={entry.keywords[0]}
              title={entry.keywords[0]}
              onClick={() => pick(entry.emoji, '')}
              className={`flex aspect-square cursor-pointer items-center justify-center rounded-lg text-2xl transition-colors hover:bg-accent ${entry.emoji === value && !brand ? 'bg-accent ring-2 ring-primary' : ''}`}
            >
              {entry.emoji}
            </button>
          ))}
          {results.length === 0 && brands.length === 0 && (
            <p className="col-span-6 py-6 text-center text-sm text-muted-foreground">
              Rien trouve pour cette recherche.
            </p>
          )}
        </div>

        {(value || brand) && (
          <Button type="button" variant="outline" onClick={() => pick('', '')}>
            Retirer l'icone
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
