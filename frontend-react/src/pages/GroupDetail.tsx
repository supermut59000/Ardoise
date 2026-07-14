import { Fragment, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Plus, Receipt, ArrowRight, Check, Menu, Users, Sun, Moon,
  Pencil, Share2, FileJson, FileSpreadsheet, Undo2, Trash2, LogOut,
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
import { RenameGroupDialog } from '@/components/group/RenameGroupDialog'
import { DeleteGroupDialog } from '@/components/group/DeleteGroupDialog'
import { LeaveGroupDialog } from '@/components/group/LeaveGroupDialog'
import { MemberAvatar } from '@/components/ui/member-avatar'
import { useGroupData } from '@/hooks/use-group-data'
import { isShared } from '@/sync/engine'
import { addExpense, addSettlement, deleteExpense, deleteSettlement } from '@/sync/ops'
import { memberShareCents } from '@/domain/balances'
import { exportGroupCsv, exportGroupJson } from '@/lib/export'
import { dayLabel, formatCents, todayIso } from '@/lib/format'
import { tapFeedback } from '@/lib/haptics'
import { useMe } from '@/lib/me'
import type { Expense, Transfer } from '@/domain/types'

type Tab = 'expenses' | 'balances'

export function GroupDetail() {
  const { groupId = '' } = useParams()
  const navigate = useNavigate()
  const data = useGroupData(groupId)
  const me = useMe(groupId)
  const { resolvedTheme, setTheme } = useTheme()
  const [tab, setTab] = useState<Tab>('expenses')
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [settling, setSettling] = useState(false)
  // "Quitter" only makes sense for a shared group (a local-only group's data
  // exists nowhere else, so the only removal is a real delete).
  const [shared, setShared] = useState(false)
  useEffect(() => {
    isShared(groupId)
      .then(setShared)
      .catch(() => setShared(false))
  }, [groupId, shareOpen]) // re-check after the share dialog may have registered it

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

  const { group, members, expenses, settlements, balances, transfers, referenced } = data
  const currency = group.currency
  const totalCents = expenses.reduce((sum, e) => sum + e.amountCents, 0)
  // Falls back gracefully if an id was removed on another device (no ugly "?").
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? 'Ancien participant'
  // In the Soldes tab, mark the local user so they spot their own lines at a glance.
  const label = (id: string) => (id === me ? `${nameOf(id)} (moi)` : nameOf(id))
  const myBalance = me ? balances.find((b) => b.memberId === me) : undefined
  // Balance bars are scaled to the largest absolute balance in the group.
  const maxAbsCents = Math.max(1, ...balances.map((b) => Math.abs(b.netCents)))

  // Undo re-creates the expense (same content, new id): a delete op is
  // terminal in the fold, so the original id cannot be resurrected.
  async function handleDelete(expense: Expense) {
    try {
      await deleteExpense(groupId, expense.id)
      tapFeedback()
      toast.success('Depense supprimee', {
        action: {
          label: 'Annuler',
          onClick: () => {
            void addExpense(groupId, {
              description: expense.description,
              amountCents: expense.amountCents,
              paidBy: expense.paidBy,
              spentAt: expense.spentAt,
              emoji: expense.emoji,
              splitMode: expense.splitMode,
              shares: expense.shares,
            })
          },
        },
      })
    } catch {
      toast.error('Suppression impossible')
    }
  }

  async function handleSettle(t: Transfer) {
    if (settling) return // a double tap must not record the settlement twice
    setSettling(true)
    try {
      await addSettlement(groupId, {
        fromMemberId: t.fromMemberId,
        toMemberId: t.toMemberId,
        amountCents: t.amountCents,
        settledAt: todayIso(),
      })
      tapFeedback()
      toast.success('Remboursement enregistre')
    } catch {
      toast.error('Enregistrement impossible')
    } finally {
      setSettling(false)
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
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <Pencil /> Renommer le groupe
            </DropdownMenuItem>
            {shared && (
              <DropdownMenuItem onSelect={() => setLeaveOpen(true)}>
                <LogOut /> Quitter le groupe (cet appareil)
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => setDeleteOpen(true)}
              className="text-destructive focus:text-destructive [&_svg]:text-destructive"
            >
              <Trash2 /> Supprimer le groupe
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Total spent, plus the local user's own share when identity is set */}
      {expenses.length > 0 && (
        <Card className="mb-4 space-y-1 rounded-2xl border-0 bg-gradient-to-br from-primary to-[var(--primary-deep)] p-4 text-primary-foreground shadow-lg shadow-primary/25">
          <div className="flex items-baseline justify-between">
            <span className="text-sm opacity-80">Total des depenses</span>
            <span className="text-2xl font-semibold tabular-nums">
              {formatCents(totalCents, currency)}
            </span>
          </div>
          {me && (
            <div className="flex items-baseline justify-between border-t border-primary-foreground/20 pt-1">
              <span className="text-sm opacity-80">Ma part</span>
              <span className="text-lg font-semibold tabular-nums">
                {formatCents(memberShareCents(expenses, me), currency)}
              </span>
            </div>
          )}
        </Card>
      )}

      {/* Participant summary with avatars (management is in the burger menu) */}
      <button
        onClick={() => setParticipantsOpen(true)}
        className="mb-4 flex w-full items-center gap-2 text-left"
        aria-label="Gerer les participants"
      >
        {members.length === 0 ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="size-4 shrink-0" /> Aucun participant. Touchez pour en ajouter.
          </span>
        ) : (
          <>
            <div className="flex -space-x-2">
              {members.slice(0, 5).map((m) => (
                <MemberAvatar key={m.id} name={m.name} seed={m.id} size="xs" />
              ))}
            </div>
            <span className="truncate text-sm text-muted-foreground">
              {members.length} participant{members.length > 1 ? 's' : ''}
            </span>
          </>
        )}
      </button>

      {/* Tabs */}
      <div role="tablist" aria-label="Vue du groupe" className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'expenses'}
          onClick={() => setTab('expenses')}
          className={`cursor-pointer rounded-md py-1.5 text-sm font-medium transition-colors ${tab === 'expenses' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
        >
          Depenses
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'balances'}
          onClick={() => setTab('balances')}
          className={`cursor-pointer rounded-md py-1.5 text-sm font-medium transition-colors ${tab === 'balances' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
        >
          Soldes
        </button>
      </div>

      {tab === 'expenses' ? (
        <section key="expenses" className="space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {expenses.length === 0 ? (
            <div className="mt-10 flex flex-col items-center gap-3 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                <Receipt className="size-6" />
              </div>
              <p className="text-sm text-muted-foreground text-balance">
                {members.length === 0
                  ? "Ajoutez d'abord des participants, puis touchez + pour votre premiere depense."
                  : 'Aucune depense. Touchez + pour ajouter la premiere.'}
              </p>
            </div>
          ) : (
            <>
              {expenses.map((e, i) => (
                <Fragment key={e.id}>
                  {/* Day header whenever the date changes (list is newest-first) */}
                  {(i === 0 || expenses[i - 1].spentAt !== e.spentAt) && (
                    <h3 className="px-1 pb-0.5 pt-2 text-xs font-medium text-muted-foreground first:pt-0">
                      {dayLabel(e.spentAt)}
                    </h3>
                  )}
                  <SwipeableCard
                    onSwipeRight={() => navigate(`/g/${groupId}/e/${e.id}`)}
                    onSwipeLeft={() => handleDelete(e)}
                  >
                    <button
                      onClick={() => navigate(`/g/${groupId}/e/${e.id}`)}
                      className="flex w-full cursor-pointer items-center gap-3 p-3 text-left"
                    >
                      {/* Emoji tile with the payer's avatar as a corner badge; plain avatar otherwise */}
                      {e.emoji ? (
                        <span className="relative shrink-0">
                          <span className="flex size-10 items-center justify-center rounded-full bg-accent text-xl">
                            {e.emoji}
                          </span>
                          <MemberAvatar
                            name={nameOf(e.paidBy)}
                            seed={e.paidBy}
                            size="xs"
                            className="absolute -bottom-1 -right-1"
                          />
                        </span>
                      ) : (
                        <MemberAvatar name={nameOf(e.paidBy)} seed={e.paidBy} size="md" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{e.description || 'Depense'}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {nameOf(e.paidBy)} a paye
                        </p>
                      </div>
                      <span className="shrink-0 font-semibold tabular-nums">{formatCents(e.amountCents, currency)}</span>
                    </button>
                  </SwipeableCard>
                </Fragment>
              ))}
              <p className="pt-1 text-center text-xs text-muted-foreground sm:hidden">
                Glissez une depense pour la modifier ou la supprimer.
              </p>
            </>
          )}
        </section>
      ) : (
        <section key="balances" className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Personal headline: the one number the local user actually cares about */}
          {myBalance && (
            <Card
              className={`p-4 text-sm font-medium ${
                myBalance.netCents > 0
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : myBalance.netCents < 0
                    ? 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
                    : 'text-muted-foreground'
              }`}
            >
              {myBalance.netCents > 0 && (
                <>On vous doit <span className="text-lg font-semibold tabular-nums">{formatCents(myBalance.netCents, currency)}</span></>
              )}
              {myBalance.netCents < 0 && (
                <>Vous devez <span className="text-lg font-semibold tabular-nums">{formatCents(-myBalance.netCents, currency)}</span></>
              )}
              {myBalance.netCents === 0 && <>Vous etes a jour, vous ne devez rien.</>}
            </Card>
          )}

          <div className="space-y-2.5">
            {balances.map((b) => (
              <div key={b.memberId} className="px-1">
                <div className="flex items-center gap-2 text-sm">
                  <MemberAvatar name={nameOf(b.memberId)} seed={b.memberId} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{label(b.memberId)}</span>
                  <span className={`shrink-0 font-semibold tabular-nums ${b.netCents > 0 ? 'text-emerald-600 dark:text-emerald-400' : b.netCents < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}`}>
                    {b.netCents > 0 ? '+' : ''}{formatCents(b.netCents, currency)}
                  </span>
                </div>
                {/* Center-axis bar: owes grows left in rose, is-owed grows right in emerald */}
                <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                  {b.netCents !== 0 && (
                    <div
                      className={`absolute inset-y-0 rounded-full transition-[width] duration-300 ${b.netCents > 0 ? 'left-1/2 bg-emerald-500' : 'right-1/2 bg-rose-500'}`}
                      style={{ width: `${(Math.abs(b.netCents) / maxAbsCents) * 50}%` }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Remboursements suggeres</h2>
            {transfers.length === 0 ? (
              <Card className="flex items-center gap-2 p-4 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="size-5" /> Tout est equilibre, personne ne doit rien.
              </Card>
            ) : (
              <ul className="space-y-2">
                {transfers.map((t, i) => (
                  <li key={i}>
                    <Card className="flex items-center gap-2 p-3 text-sm">
                      <MemberAvatar name={nameOf(t.fromMemberId)} seed={t.fromMemberId} size="xs" />
                      <span className="truncate font-medium">{label(t.fromMemberId)}</span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      <MemberAvatar name={nameOf(t.toMemberId)} seed={t.toMemberId} size="xs" />
                      <span className="truncate font-medium">{label(t.toMemberId)}</span>
                      <span className="ml-auto shrink-0 tabular-nums font-semibold">{formatCents(t.amountCents, currency)}</span>
                      <Button size="sm" variant="outline" className="ml-1 h-8 shrink-0" disabled={settling} onClick={() => handleSettle(t)}>
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
                      <Check className="size-4 shrink-0 text-emerald-500" />
                      <span className="truncate font-medium">{label(s.fromMemberId)}</span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{label(s.toMemberId)}</span>
                      <span className="ml-auto shrink-0 tabular-nums font-semibold">{formatCents(s.amountCents, currency)}</span>
                      <button
                        type="button"
                        onClick={() => handleUnsettle(s.id)}
                        aria-label="Annuler le remboursement"
                        className="-m-1 ml-0 shrink-0 cursor-pointer p-2 text-muted-foreground hover:text-foreground"
                      >
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

      {/* Add-expense FAB. Fixed elements ignore the body's safe-area padding,
          so it needs its own inset or the home-indicator zone swallows it. */}
      {members.length > 0 && (
        <Link
          to={`/g/${groupId}/add`}
          className="fixed inset-x-0 z-40 mx-auto flex max-w-md justify-end px-4"
          style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
        >
          <Button
            size="lg"
            className="size-14 rounded-full shadow-lg shadow-primary/30 transition-transform active:scale-90"
            aria-label="Ajouter une depense"
          >
            <Plus className="size-6" />
          </Button>
        </Link>
      )}

      <ParticipantsDialog
        groupId={groupId}
        members={members}
        referenced={referenced}
        open={participantsOpen}
        onOpenChange={setParticipantsOpen}
      />
      <ShareDialog groupId={groupId} open={shareOpen} onOpenChange={setShareOpen} />
      <RenameGroupDialog groupId={groupId} currentName={group.name} open={renameOpen} onOpenChange={setRenameOpen} />
      <DeleteGroupDialog groupId={groupId} groupName={group.name} open={deleteOpen} onOpenChange={setDeleteOpen} />
      <LeaveGroupDialog groupId={groupId} groupName={group.name} open={leaveOpen} onOpenChange={setLeaveOpen} />
    </main>
  )
}
