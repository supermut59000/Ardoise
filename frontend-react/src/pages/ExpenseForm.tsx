import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Trash2, SmilePlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { DateField } from '@/components/ui/date-field'
import { useGroupData } from '@/hooks/use-group-data'
import { addExpense, deleteExpense, updateExpense } from '@/sync/ops'
import { computeOwed, distributeRemainder, pinnedParts, validateSplit } from '@/domain/split'
import type { ExpenseShare, SplitMode } from '@/domain/types'
import { MemberAvatar } from '@/components/ui/member-avatar'
import { EmojiPickerDialog } from '@/components/expense/EmojiPickerDialog'
import { BrandMark } from '@/components/ui/brand-mark'
import { suggestEmoji } from '@/lib/emoji'
import { findBrand, suggestBrand } from '@/lib/brands'
import { formatCents, limitTwoDecimals, parseAmountToCents, todayIso } from '@/lib/format'
import { tapFeedback } from '@/lib/haptics'
import { useMe } from '@/lib/me'

const MODES: { value: SplitMode; label: string }[] = [
  { value: 'equal', label: 'Egal' },
  { value: 'shares', label: 'Parts' },
  { value: 'percent', label: '%' },
  { value: 'exact', label: 'Exact' },
]

const centsToInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')
/** Centi-percent (3333) as a clean French input value ("33,33", "50"). */
const centiToInput = (centi: number) =>
  centi % 100 === 0 ? String(centi / 100) : (centi / 100).toFixed(2).replace('.', ',')
/** Parts accept decimals ("1,5"); invalid text remains NaN so validation blocks it. */
const parseParts = (text: string) => {
  const value = Number(text.replace(',', '.'))
  return text.trim() && Number.isFinite(value) ? value : Number.NaN
}

/** Add mode (route /g/:groupId/add) and edit mode (/g/:groupId/e/:expenseId). */
export function ExpenseForm() {
  const { groupId = '', expenseId } = useParams()
  const isEdit = Boolean(expenseId)
  const navigate = useNavigate()
  const data = useGroupData(groupId)
  const me = useMe(groupId)

  const [description, setDescription] = useState('')
  const [emoji, setEmoji] = useState('')
  // Brand id ('' = none): "Burger King" shows the logo instead of the emoji.
  const [brand, setBrand] = useState('')
  // Once the user picks (or clears) an icon themselves, stop auto-suggesting.
  const [emojiTouched, setEmojiTouched] = useState(false)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [paidBy, setPaidBy] = useState('')
  const [spentAt, setSpentAt] = useState(todayIso())
  const [splitMode, setSplitMode] = useState<SplitMode>('equal')
  // Who takes part, in EVERY mode: the split is always "these people share this".
  const [included, setIncluded] = useState<Set<string>>(new Set())
  // Parts the user typed by hand this session. Everyone else absorbs the rest,
  // so setting "Bob 40 %" never requires working out the others.
  const [typed, setTyped] = useState<Record<string, string>>({})
  // Parts of the expense being edited, shown as-is until the user types
  // anything (then they become absorbers, like in add mode).
  const [seed, setSeed] = useState<Record<string, number> | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)

  if (data === undefined) {
    return (
      <main className="mx-auto w-full max-w-md px-4 pb-24 pt-6" aria-hidden="true">
        <div className="mb-6 h-8 w-1/2 animate-pulse rounded-lg bg-muted" />
        <div className="space-y-5">
          <div className="h-11 animate-pulse rounded-md bg-muted" />
          <div className="h-11 animate-pulse rounded-md bg-muted" />
          <div className="h-11 animate-pulse rounded-md bg-muted" />
          <div className="h-44 animate-pulse rounded-xl bg-muted" />
        </div>
      </main>
    )
  }
  const members = data.members
  const existing = expenseId ? data.expenses.find((e) => e.id === expenseId) : undefined
  const pickedBrand = findBrand(brand)
  const amountCents = parseAmountToCents(amount) ?? 0

  if (isEdit && !existing) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p className="text-sm text-muted-foreground">Depense introuvable.</p>
        <Link to={`/g/${groupId}`} className="text-sm underline">Retour</Link>
      </main>
    )
  }

  // One-time prefill.
  if (!initialized && members.length > 0) {
    if (existing) {
      setDescription(existing.description)
      setEmoji(existing.emoji ?? '')
      setBrand(existing.brand ?? '')
      setEmojiTouched(true)
      setAmount(centsToInput(existing.amountCents))
      setPaidBy(existing.paidBy)
      setSpentAt(existing.spentAt)
      const mode = existing.splitMode ?? 'equal'
      setSplitMode(mode)
      setIncluded(new Set(existing.shares.map((s) => s.memberId)))
      if (mode === 'shares') {
        // Parts are relative, nothing to balance: show them as plain inputs.
        const r: Record<string, string> = {}
        for (const s of existing.shares) r[s.memberId] = String(s.weight).replace('.', ',')
        setTyped(r)
      } else if (mode === 'percent' || mode === 'exact') {
        const s: Record<string, number> = {}
        for (const share of existing.shares) {
          s[share.memberId] = mode === 'exact' ? share.weight : Math.round(share.weight * 100)
        }
        setSeed(s)
      }
    } else {
      // Default the payer to the local user when they told us who they are.
      setPaidBy(me && members.some((m) => m.id === me) ? me : members[0].id)
      setIncluded(new Set(members.map((m) => m.id)))
    }
    setInitialized(true)
  }

  function changeMode(mode: SplitMode) {
    setSplitMode(mode)
    // Values are mode-specific (parts, percent, cents): start the new mode from
    // an even split of whoever is selected.
    setTyped({})
    setSeed(null)
  }

  function toggleIncluded(id: string) {
    setIncluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    // A member taken out and put back in becomes an absorber again.
    setTyped((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  /** Back to a plain even split between the selected members. */
  function resetSplit() {
    setTyped({})
    setSeed(null)
  }

  // Selected members in group order, so the leftover cent always lands on the
  // same person on every device.
  const selectedIds = members.filter((m) => included.has(m.id)).map((m) => m.id)
  const hasTyped = Object.keys(typed).length > 0
  const isBalanced = splitMode === 'percent' || splitMode === 'exact'

  // Typed text parsed into the mode's unit: hundredths of a euro (cents) or of
  // a percent (centi-percent). A present-but-null entry means the user is mid
  // edit; the member is simply not pinned.
  const typedParts = Object.fromEntries(
    Object.entries(typed).map(([id, text]) => [id, parseAmountToCents(text)]),
  )

  // Everyone selected gets a part; the untouched ones share what is left.
  const balanced = isBalanced
    ? distributeRemainder(
        splitMode === 'exact' ? amountCents : 10_000,
        selectedIds,
        pinnedParts(selectedIds, typedParts, seed),
      )
    : null

  /** What an input shows: the text being typed, otherwise the computed part. */
  function partInput(id: string): string {
    if (splitMode === 'shares') return typed[id] ?? '1'
    if (hasTyped && typed[id] !== undefined) return typed[id]
    const value = balanced?.get(id) ?? 0
    return splitMode === 'exact' ? centsToInput(value) : centiToInput(value)
  }

  // Build the shares array from the current mode's inputs.
  function buildShares(): ExpenseShare[] {
    if (splitMode === 'equal') return selectedIds.map((memberId) => ({ memberId, weight: 1 }))
    if (splitMode === 'shares') {
      return selectedIds.map((memberId) => ({ memberId, weight: parseParts(typed[memberId] ?? '1') }))
    }
    // percent weights are plain percentages (33,33), exact weights are cents.
    return selectedIds.map((memberId) => {
      const value = balanced?.get(memberId) ?? 0
      return { memberId, weight: splitMode === 'exact' ? value : value / 100 }
    })
  }

  const shares = buildShares()
  const splitError = amount ? validateSplit(splitMode, amountCents, shares) : null
  const owed = !splitError && amountCents > 0 ? computeOwed(amountCents, splitMode, shares) : null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (amountCents === 0) return toast.error('Montant invalide')
    if (!paidBy) return toast.error('Choisissez qui a paye')
    const err = validateSplit(splitMode, amountCents, shares)
    if (err) return toast.error(err)

    setSaving(true)
    const payload = {
      description: description.trim(),
      amountCents,
      paidBy,
      spentAt,
      emoji,
      brand,
      splitMode,
      shares,
    }
    try {
      if (isEdit && expenseId) await updateExpense(groupId, expenseId, payload)
      else await addExpense(groupId, payload)
      tapFeedback()
      navigate(`/g/${groupId}`)
    } catch {
      toast.error('Enregistrement impossible')
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!expenseId || !existing) return
    const snapshot = existing
    try {
      await deleteExpense(groupId, expenseId)
      // Undo re-creates the expense (new id): a delete op is terminal in the fold.
      toast.success('Depense supprimee', {
        action: {
          label: 'Annuler',
          onClick: () => {
            void addExpense(groupId, {
              description: snapshot.description,
              amountCents: snapshot.amountCents,
              paidBy: snapshot.paidBy,
              spentAt: snapshot.spentAt,
              emoji: snapshot.emoji,
              brand: snapshot.brand,
              splitMode: snapshot.splitMode,
              shares: snapshot.shares,
            })
          },
        },
      })
      navigate(`/g/${groupId}`)
    } catch {
      toast.error('Suppression impossible')
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-24 pt-6">
      <header className="mb-6 flex items-center gap-2">
        <Link to={`/g/${groupId}`} aria-label="Retour">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="size-5" />
          </Button>
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {isEdit ? 'Modifier la depense' : 'Nouvelle depense'}
        </h1>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="desc" className="text-sm font-medium">Description</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEmojiPickerOpen(true)}
              aria-label={
                pickedBrand
                  ? `Logo : ${pickedBrand.name}. Changer`
                  : emoji
                    ? `Emoji : ${emoji}. Changer`
                    : 'Choisir une icone'
              }
              title="Choisir une icone"
              className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md border text-xl transition-colors hover:bg-accent"
            >
              {pickedBrand ? (
                <BrandMark brand={pickedBrand} size="sm" />
              ) : (
                emoji || <SmilePlus className="size-5 text-muted-foreground" />
              )}
            </button>
            <Input
              id="desc"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                // Live suggestion: "Burger King" -> the logo, "essence" -> pompe.
                // A brand wins over the generic emoji and carries its own as a
                // fallback, so lists that show emojis stay lively.
                if (!emojiTouched) {
                  const match = suggestBrand(e.target.value)
                  setBrand(match?.id ?? '')
                  setEmoji(match?.emoji ?? suggestEmoji(e.target.value) ?? '')
                }
              }}
              placeholder="Courses, restaurant..."
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="amount" className="text-sm font-medium">Montant</label>
          <Input id="amount" value={amount} onChange={(e) => setAmount(limitTwoDecimals(e.target.value))} placeholder="0,00" inputMode="decimal" autoFocus={!isEdit} />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="paidBy" className="text-sm font-medium">Paye par</label>
          <Select id="paidBy" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="date" className="text-sm font-medium">Date</label>
          <DateField id="date" value={spentAt} onChange={setSpentAt} />
        </div>

        {/* Split editor */}
        <div className="space-y-2">
          <span className="text-sm font-medium">Partage</span>
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
            {MODES.map((m) => (
              <button
                type="button"
                key={m.value}
                onClick={() => changeMode(m.value)}
                className={`cursor-pointer rounded-md py-1.5 text-sm font-medium transition-colors ${splitMode === m.value ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="space-y-1.5 pt-1">
            {members.map((m) => {
              const owedCents = owed?.get(m.id)
              if (splitMode === 'equal') {
                const active = included.has(m.id)
                return (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => toggleIncluded(m.id)}
                    aria-pressed={active}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${active ? 'border-primary bg-accent/50' : 'text-muted-foreground'}`}
                  >
                    <MemberAvatar name={m.name} seed={m.id} size="xs" className={active ? '' : 'opacity-50'} />
                    <span className="min-w-0 flex-1 truncate text-left">{m.name}</span>
                    {active && owedCents !== undefined && (
                      <span className="tabular-nums text-muted-foreground">{formatCents(owedCents)}</span>
                    )}
                  </button>
                )
              }
              const active = included.has(m.id)
              return (
                <div
                  key={m.id}
                  className={`flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${active ? 'border-primary bg-accent/50' : ''}`}
                >
                  {/* Same tap-to-include affordance as the equal mode: you pick
                      who takes part first, the parts follow. */}
                  <button
                    type="button"
                    onClick={() => toggleIncluded(m.id)}
                    aria-pressed={active}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  >
                    <MemberAvatar name={m.name} seed={m.id} size="xs" className={active ? '' : 'opacity-50'} />
                    <span className={`min-w-0 flex-1 truncate text-sm ${active ? '' : 'text-muted-foreground'}`}>
                      {m.name}
                    </span>
                  </button>
                  {active ? (
                    <>
                      {splitMode !== 'exact' && owedCents !== undefined && (
                        <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {formatCents(owedCents)}
                        </span>
                      )}
                      <Input
                        value={partInput(m.id)}
                        onChange={(e) =>
                          // Parts are ratios and may legitimately have decimals
                          // ("1,5"), but percents/exact money are capped at two
                          // decimals so a third never reaches the split math.
                          setTyped((prev) => ({
                            ...prev,
                            [m.id]: splitMode === 'shares' ? e.target.value : limitTwoDecimals(e.target.value),
                          }))
                        }
                        inputMode="decimal"
                        className="h-9 w-20 shrink-0 text-right"
                        aria-label={`${m.name} ${splitMode}`}
                      />
                      {splitMode !== 'exact' && (
                        <span className="w-8 shrink-0 text-xs text-muted-foreground">
                          {splitMode === 'percent' ? '%' : 'parts'}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="shrink-0 pr-1 text-xs text-muted-foreground">Non concerne</span>
                  )}
                </div>
              )
            })}
          </div>

          <div className="flex items-start justify-between gap-2">
            {splitError && amount ? (
              <p className="text-xs text-destructive">{splitError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {splitMode === 'equal' && 'Part egale entre les participants selectionnes.'}
                {splitMode === 'shares' && 'Repartition selon le nombre de parts.'}
                {splitMode === 'percent' && "Modifiez une part, le reste s'ajuste."}
                {splitMode === 'exact' && "Modifiez un montant, le reste s'ajuste."}
              </p>
            )}
            {isBalanced && (hasTyped || seed) && (
              <button
                type="button"
                onClick={resetSplit}
                className="shrink-0 cursor-pointer text-xs text-muted-foreground underline transition-colors hover:text-foreground"
              >
                Repartir egalement
              </button>
            )}
          </div>
        </div>

        {/* Sticky action bar: the core action must stay on screen no matter
            how many split rows the form grows to. */}
        <div className="sticky bottom-0 -mx-4 space-y-2 bg-background/95 px-4 pb-2 pt-3 backdrop-blur-sm">
          <Button type="submit" size="lg" className="w-full" disabled={saving || Boolean(splitError)}>
            {isEdit ? 'Enregistrer les modifications' : 'Enregistrer'}
          </Button>

          {isEdit && (
            <Button type="button" variant="ghost" className="w-full text-destructive" onClick={handleDelete}>
              <Trash2 className="size-4" /> Supprimer cette depense
            </Button>
          )}
        </div>
      </form>

      <EmojiPickerDialog
        value={emoji}
        brand={brand}
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onSelect={(pickedEmoji, pickedBrandId) => {
          setEmoji(pickedEmoji)
          setBrand(pickedBrandId)
          setEmojiTouched(true)
        }}
      />
    </main>
  )
}
