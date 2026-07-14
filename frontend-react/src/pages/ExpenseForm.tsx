import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Trash2, SmilePlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useGroupData } from '@/hooks/use-group-data'
import { addExpense, deleteExpense, updateExpense } from '@/sync/ops'
import { computeOwed, validateSplit } from '@/domain/split'
import type { ExpenseShare, SplitMode } from '@/domain/types'
import { MemberAvatar } from '@/components/ui/member-avatar'
import { EmojiPickerDialog } from '@/components/expense/EmojiPickerDialog'
import { suggestEmoji } from '@/lib/emoji'
import { formatCents, parseAmountToCents, todayIso } from '@/lib/format'
import { tapFeedback } from '@/lib/haptics'
import { useMe } from '@/lib/me'

const MODES: { value: SplitMode; label: string }[] = [
  { value: 'equal', label: 'Egal' },
  { value: 'shares', label: 'Parts' },
  { value: 'percent', label: '%' },
  { value: 'exact', label: 'Exact' },
]

const centsToInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')

/** Add mode (route /g/:groupId/add) and edit mode (/g/:groupId/e/:expenseId). */
export function ExpenseForm() {
  const { groupId = '', expenseId } = useParams()
  const isEdit = Boolean(expenseId)
  const navigate = useNavigate()
  const data = useGroupData(groupId)
  const me = useMe(groupId)

  const [description, setDescription] = useState('')
  const [emoji, setEmoji] = useState('')
  // Once the user picks (or clears) an emoji themselves, stop auto-suggesting.
  const [emojiTouched, setEmojiTouched] = useState(false)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [paidBy, setPaidBy] = useState('')
  const [spentAt, setSpentAt] = useState(todayIso())
  const [splitMode, setSplitMode] = useState<SplitMode>('equal')
  const [included, setIncluded] = useState<Set<string>>(new Set()) // equal mode
  const [raw, setRaw] = useState<Record<string, string>>({}) // shares/percent/exact
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)

  if (data === undefined) {
    return <p className="mx-auto max-w-md p-6 text-sm text-muted-foreground">Chargement...</p>
  }
  const members = data.members
  const existing = expenseId ? data.expenses.find((e) => e.id === expenseId) : undefined
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
      setEmojiTouched(true)
      setAmount(centsToInput(existing.amountCents))
      setPaidBy(existing.paidBy)
      setSpentAt(existing.spentAt)
      const mode = existing.splitMode ?? 'equal'
      setSplitMode(mode)
      setIncluded(new Set(existing.shares.map((s) => s.memberId)))
      const r: Record<string, string> = {}
      for (const s of existing.shares) {
        r[s.memberId] = mode === 'exact' ? centsToInput(s.weight) : String(s.weight)
      }
      setRaw(r)
    } else {
      // Default the payer to the local user when they told us who they are.
      setPaidBy(me && members.some((m) => m.id === me) ? me : members[0].id)
      setIncluded(new Set(members.map((m) => m.id)))
    }
    setInitialized(true)
  }

  function initRawFor(mode: SplitMode): Record<string, string> {
    const ids = members.map((m) => m.id)
    if (mode === 'shares') return Object.fromEntries(ids.map((id) => [id, '1']))
    if (mode === 'percent') {
      const base = Math.floor(100 / ids.length)
      const remainder = 100 - base * ids.length
      return Object.fromEntries(ids.map((id, i) => [id, String(base + (i < remainder ? 1 : 0))]))
    }
    if (mode === 'exact') {
      const per = computeOwed(amountCents, 'equal', ids.map((id) => ({ memberId: id, weight: 1 })))
      return Object.fromEntries(ids.map((id) => [id, centsToInput(per.get(id) ?? 0)]))
    }
    return {}
  }

  function changeMode(mode: SplitMode) {
    setSplitMode(mode)
    if (mode !== 'equal') setRaw(initRawFor(mode))
  }

  function toggleIncluded(id: string) {
    setIncluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Build the shares array from the current mode's inputs.
  function buildShares(): ExpenseShare[] {
    if (splitMode === 'equal') {
      return [...included].map((memberId) => ({ memberId, weight: 1 }))
    }
    const out: ExpenseShare[] = []
    for (const m of members) {
      const text = raw[m.id] ?? ''
      const weight =
        splitMode === 'exact'
          ? (parseAmountToCents(text) ?? 0)
          : Math.floor(Number(text.replace(',', '.')) || 0)
      if (weight > 0) out.push({ memberId: m.id, weight })
    }
    return out
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
              aria-label={emoji ? `Emoji : ${emoji}. Changer` : 'Choisir un emoji'}
              title="Choisir un emoji"
              className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md border text-xl transition-colors hover:bg-accent"
            >
              {emoji || <SmilePlus className="size-5 text-muted-foreground" />}
            </button>
            <Input
              id="desc"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                // Live suggestion: "Courses" -> caddie, "essence" -> pompe...
                if (!emojiTouched) setEmoji(suggestEmoji(e.target.value) ?? '')
              }}
              placeholder="Courses, restaurant..."
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="amount" className="text-sm font-medium">Montant</label>
          <Input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" inputMode="decimal" autoFocus={!isEdit} />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="paidBy" className="text-sm font-medium">Paye par</label>
          <select
            id="paidBy"
            value={paidBy}
            onChange={(e) => setPaidBy(e.target.value)}
            className="h-11 w-full rounded-md border bg-transparent px-3 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="date" className="text-sm font-medium">Date</label>
          <Input id="date" type="date" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} />
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
                className={`cursor-pointer rounded-md py-1.5 text-sm font-medium transition-colors ${splitMode === m.value ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
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
              return (
                <div key={m.id} className="flex items-center gap-2">
                  <MemberAvatar name={m.name} seed={m.id} size="xs" />
                  <span className="flex-1 truncate text-sm">{m.name}</span>
                  {splitMode !== 'exact' && owedCents !== undefined && (
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {formatCents(owedCents)}
                    </span>
                  )}
                  <Input
                    value={raw[m.id] ?? ''}
                    onChange={(e) => setRaw((prev) => ({ ...prev, [m.id]: e.target.value }))}
                    inputMode="decimal"
                    className="h-9 w-24 text-right"
                    placeholder={splitMode === 'percent' ? '%' : splitMode === 'exact' ? '0,00' : 'parts'}
                    aria-label={`${m.name} ${splitMode}`}
                  />
                </div>
              )
            })}
          </div>

          {splitError && amount ? (
            <p className="text-xs text-destructive">{splitError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {splitMode === 'equal' && 'Part egale entre les participants selectionnes.'}
              {splitMode === 'shares' && 'Repartition selon le nombre de parts.'}
              {splitMode === 'percent' && 'Les pourcentages doivent totaliser 100.'}
              {splitMode === 'exact' && 'Les montants doivent totaliser la depense.'}
            </p>
          )}
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={saving || Boolean(splitError)}>
          {isEdit ? 'Enregistrer les modifications' : 'Enregistrer'}
        </Button>

        {isEdit && (
          <Button type="button" variant="ghost" className="w-full text-destructive" onClick={handleDelete}>
            <Trash2 className="size-4" /> Supprimer cette depense
          </Button>
        )}
      </form>

      <EmojiPickerDialog
        value={emoji}
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onSelect={(picked) => {
          setEmoji(picked)
          setEmojiTouched(true)
        }}
      />
    </main>
  )
}
