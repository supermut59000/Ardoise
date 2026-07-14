import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Plus, Receipt, ArrowRight, Check, Menu, Users, Sun, Moon,
  Pencil, Share2, FileJson, FileSpreadsheet, Undo2,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { SwipeableCard } from '@/components/ui/swipeable-card'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ParticipantsDialog } from '@/components/group/ParticipantsDialog'
import { ShareDialog } from '@/components/group/ShareDialog'
import { useGroupData } from '@/hooks/use-group-data'
import { addSettlement, deleteExpense, deleteSettlement } from '@/sync/ops'
import { exportGroupCsv, exportGroupJson } from '@/lib/export'
import { formatCents, formatDate, todayIso } from '@/lib/format'
import type { Transfer } from '@/domain/types'

type Tab = 'expenses' | 'balances'

export function GroupDetail() {
  const { groupId = '' } = useParams()
  const navigate = useNavigate()
  const data = useGroupData(groupId)
  const { resolvedTheme, setTheme } = useTheme()
  const [tab, setTab] = useState<Tab>('expenses')
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  if (data === undefined) {
    return <p className="mx-auto max-w-md p-6 text-sm text-muted-foreground">Chargement...</p>
  }
  if (!data.group) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p className="text-sm text-muted-foreground">Groupe introuvable.</p>
        <Link to="/" className="text-sm underline">Retour</Link>
      </main>
    )
  }

  const { group, members, expenses, settlements, balances, transfers } = data
  const currency = group.currency
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? '?'

  async function handleDelete(expenseId: string) {
    try {
      await deleteExpense(groupId, expenseId)
      toast.success('Depense supprimee')
    } catch {
      toast.error('Suppression impossible')
    }
  }

  async function handleSettle(t: Transfer) {
    try {
      await addSettlement(groupId, {
        fromMemberId: t.fromMemberId,
        toMemberId: t.toMemberId,
        amountCents: t.amountCents,
        settledAt: todayIso(),
      })
      toast.success('Remboursement enregistre')
    } catch {
      toast.error('Enregistrement impossible')
    }
  }

  async function handleUnsettle(settlementId: string) {
    try {
      await deleteSettlement(groupId, settlementId)
      toast.success('Remboursement annule')
    } catch {
      toast.error('Annulation impossible')
    }
  }

  async function runExport(fn: () => Promise<void>) {
    try {
      await fn()
    } catch {
      toast.error('Export impossible')
    }
  }

  const isDark = resolvedTheme === 'dark'

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-28 pt-6">
      <header className="mb-4 flex items-center gap-2">
        <Link to="/" aria-label="Retour">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="size-5" />
          </Button>
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">{group.name}</h1>

        {/* Burger menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Menu">
              <Menu className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{group.name}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setParticipantsOpen(true)}>
              <Users /> Participants
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setShareOpen(true)}>
              <Share2 /> Partager
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme(isDark ? 'light' : 'dark')}>
              {isDark ? <Sun /> : <Moon />} {isDark ? 'Theme clair' : 'Theme sombre'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Exporter</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => runExport(() => exportGroupCsv(groupId))}>
              <FileSpreadsheet /> Exporter en CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => runExport(() => exportGroupJson(groupId))}>
              <FileJson /> Exporter en JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <Pencil /> Renommer le groupe (bientot)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Participant summary (management is in the burger menu) */}
      <button
        onClick={() => setParticipantsOpen(true)}
        className="mb-4 flex w-full items-center gap-2 text-left text-sm text-muted-foreground"
      >
        <Users className="size-4 shrink-0" />
        <span className="truncate">
          {members.length === 0
            ? 'Aucun participant. Touchez pour en ajouter.'
            : members.map((m) => m.name).join(', ')}
        </span>
      </button>

      {/* Tabs */}
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        <button
          onClick={() => setTab('expenses')}
          className={`rounded-md py-1.5 text-sm font-medium ${tab === 'expenses' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
        >
          Depenses
        </button>
        <button
          onClick={() => setTab('balances')}
          className={`rounded-md py-1.5 text-sm font-medium ${tab === 'balances' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
        >
          Soldes
        </button>
      </div>

      {tab === 'expenses' ? (
        <section className="space-y-2">
          {expenses.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune depense. Touchez + pour en ajouter une.</p>
          ) : (
            expenses.map((e) => (
              <SwipeableCard
                key={e.id}
                onSwipeRight={() => navigate(`/g/${groupId}/e/${e.id}`)}
                onSwipeLeft={() => handleDelete(e.id)}
              >
                <button
                  onClick={() => navigate(`/g/${groupId}/e/${e.id}`)}
                  className="flex w-full items-center gap-3 p-3 text-left"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
                    <Receipt className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{e.description || 'Depense'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {nameOf(e.paidBy)} a paye &middot; {formatDate(e.spentAt)}
                    </p>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums">{formatCents(e.amountCents, currency)}</span>
                </button>
              </SwipeableCard>
            ))
          )}
          <p className="pt-1 text-center text-xs text-muted-foreground sm:hidden">
            Glissez une depense pour la modifier ou la supprimer.
          </p>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="space-y-1">
            {balances.map((b) => (
              <div key={b.memberId} className="flex items-center justify-between px-1 text-sm">
                <span>{nameOf(b.memberId)}</span>
                <span className={`font-semibold tabular-nums ${b.netCents > 0 ? 'text-emerald-600 dark:text-emerald-400' : b.netCents < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}`}>
                  {b.netCents > 0 ? '+' : ''}{formatCents(b.netCents, currency)}
                </span>
              </div>
            ))}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Remboursements suggeres</h2>
            {transfers.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="size-4" /> Tout est equilibre.
              </p>
            ) : (
              <ul className="space-y-2">
                {transfers.map((t, i) => (
                  <li key={i}>
                    <Card className="flex items-center gap-2 p-3 text-sm">
                      <span className="font-medium">{nameOf(t.fromMemberId)}</span>
                      <ArrowRight className="size-4 text-muted-foreground" />
                      <span className="font-medium">{nameOf(t.toMemberId)}</span>
                      <span className="ml-auto tabular-nums font-semibold">{formatCents(t.amountCents, currency)}</span>
                      <Button size="sm" variant="outline" className="ml-1 h-8" onClick={() => handleSettle(t)}>
                        Regler
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Recorded settlements */}
          {settlements.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">Remboursements enregistres</h2>
              <ul className="space-y-2">
                {settlements.map((s) => (
                  <li key={s.id}>
                    <Card className="flex items-center gap-2 p-3 text-sm">
                      <Check className="size-4 text-emerald-500" />
                      <span className="font-medium">{nameOf(s.fromMemberId)}</span>
                      <ArrowRight className="size-4 text-muted-foreground" />
                      <span className="font-medium">{nameOf(s.toMemberId)}</span>
                      <span className="ml-auto tabular-nums font-semibold">{formatCents(s.amountCents, currency)}</span>
                      <button onClick={() => handleUnsettle(s.id)} aria-label="Annuler" className="ml-1 text-muted-foreground">
                        <Undo2 className="size-4" />
                      </button>
                    </Card>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Add-expense FAB */}
      {members.length > 0 && (
        <Link to={`/g/${groupId}/add`} className="fixed inset-x-0 bottom-6 mx-auto flex max-w-md justify-end px-4">
          <Button size="lg" className="size-14 rounded-full shadow-lg" aria-label="Ajouter une depense">
            <Plus className="size-6" />
          </Button>
        </Link>
      )}

      <ParticipantsDialog
        groupId={groupId}
        members={members}
        open={participantsOpen}
        onOpenChange={setParticipantsOpen}
      />
      <ShareDialog groupId={groupId} open={shareOpen} onOpenChange={setShareOpen} />
    </main>
  )
}
