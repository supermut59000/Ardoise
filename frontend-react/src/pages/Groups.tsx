import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Wallet, ChevronRight, Menu, Sun, Moon, Download, Upload, LogIn, DownloadCloud, KeyRound, Users, Bell, BellOff } from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { InstallHelpDialog } from '@/components/layout/InstallHelpDialog'
import { MemberAvatar } from '@/components/ui/member-avatar'
import { useGroups } from '@/hooks/use-groups'
import { useInstallPrompt } from '@/hooks/use-install-prompt'
import { usePush } from '@/hooks/use-push'
import { syncPushGroups } from '@/lib/push'
import { createGroup } from '@/sync/ops'
import { joinGroup } from '@/sync/engine'
import { SyncError } from '@/sync/client'
import { AUTH_SUCCESS_EVENT, promptForApiKey } from '@/lib/auth'
import { avatarColor } from '@/lib/avatar'
import { exportAllJson, importJsonExport } from '@/lib/export'
import { formatCents } from '@/lib/format'
import { tapFeedback } from '@/lib/haptics'

export function Groups() {
  const groups = useGroups()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { resolvedTheme, setTheme } = useTheme()
  const { isStandalone, canInstall, isIOS, promptInstall } = useInstallPrompt()
  const push = usePush()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [installHelpOpen, setInstallHelpOpen] = useState(false)
  const isDark = resolvedTheme === 'dark'
  const autoJoined = useRef(false)
  // A join interrupted by the password gate; retried once the key is accepted.
  const pendingJoin = useRef<string | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  // Show install only when not already installed and either the native prompt is
  // ready (Android) or we're on iOS (manual instructions).
  const showInstall = !isStandalone && (canInstall || isIOS)

  function handleInstall() {
    if (canInstall) void promptInstall()
    else setInstallHelpOpen(true)
  }

  async function handleJoin(code: string) {
    const trimmed = code.trim()
    if (!trimmed || joining) return
    setJoining(true)
    try {
      const groupId = await joinGroup(trimmed)
      setJoinCode('')
      pendingJoin.current = null
      void syncPushGroups() // follow the new group's notifications too
      navigate(`/g/${groupId}`)
    } catch (e) {
      if (e instanceof SyncError && e.status === 401) {
        // First-run friend flow: remember the code (and show it in the input)
        // so entering the password does not lose the invite.
        pendingJoin.current = trimmed
        setJoinCode(trimmed)
        promptForApiKey()
      } else {
        toast.error('Code invalide ou serveur injoignable')
      }
    } finally {
      setJoining(false)
    }
  }
  const handleJoinRef = useRef(handleJoin)
  handleJoinRef.current = handleJoin

  // Auto-join when arriving via an invite link (/?join=CODE).
  useEffect(() => {
    const code = searchParams.get('join')
    if (code && !autoJoined.current) {
      autoJoined.current = true
      setSearchParams({}, { replace: true })
      void handleJoin(code)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Once the password is accepted, retry the join that hit the 401.
  useEffect(() => {
    const onAuthSuccess = () => {
      const code = pendingJoin.current
      if (code) {
        pendingJoin.current = null
        void handleJoinRef.current(code)
      }
    }
    window.addEventListener(AUTH_SUCCESS_EVENT, onAuthSuccess)
    return () => window.removeEventListener(AUTH_SUCCESS_EVENT, onAuthSuccess)
  }, [])

  async function handleImportFile(file: File) {
    try {
      const result = await importJsonExport(await file.text())
      if (result.imported > 0) {
        toast.success(`${result.imported} operation${result.imported > 1 ? 's' : ''} importee${result.imported > 1 ? 's' : ''}`)
      } else {
        toast.info('Rien de nouveau dans ce fichier, tout etait deja present.')
      }
      if (result.invalid > 0) toast.warning(`${result.invalid} entree(s) illisible(s) ignoree(s)`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import impossible')
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      await createGroup({ name: trimmed })
      setName('')
      tapFeedback()
    } catch {
      toast.error('Impossible de creer le groupe')
    } finally {
      setCreating(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-24 pt-8">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Wallet className="size-5" />
        </div>
        <h1 className="flex-1 text-2xl font-semibold tracking-tight">Ardoise</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Menu">
              <Menu className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setTheme(isDark ? 'light' : 'dark')}>
              {isDark ? <Sun /> : <Moon />} {isDark ? 'Theme clair' : 'Theme sombre'}
            </DropdownMenuItem>
            {showInstall && (
              <DropdownMenuItem onSelect={handleInstall}>
                <DownloadCloud /> Installer l'application
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => promptForApiKey()}>
              <KeyRound /> Mot de passe du serveur
            </DropdownMenuItem>
            {push.state === 'off' && (
              <DropdownMenuItem onSelect={() => void push.enable()} disabled={push.busy}>
                <Bell /> Activer les notifications
              </DropdownMenuItem>
            )}
            {push.state === 'on' && (
              <DropdownMenuItem onSelect={() => void push.disable()} disabled={push.busy}>
                <BellOff /> Desactiver les notifications
              </DropdownMenuItem>
            )}
            {/* iOS in Safari: push only exists once installed on the home screen */}
            {push.state === 'unsupported' && isIOS && !isStandalone && (
              <DropdownMenuItem onSelect={() => setInstallHelpOpen(true)}>
                <Bell /> Notifications (installer l'app d'abord)
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { void exportAllJson() }}>
              <Download /> Exporter toutes les donnees (JSON)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => importInput.current?.click()}>
              <Upload /> Importer un export (JSON)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Hidden file input driven by the menu item above */}
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // allow re-picking the same file
            if (file) void handleImportFile(file)
          }}
        />
      </header>

      <form onSubmit={handleCreate} className="mb-6 flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom du groupe (ex : Week-end Bretagne)"
          aria-label="Nom du groupe"
        />
        <Button type="submit" size="icon" disabled={creating || !name.trim()} aria-label="Creer le groupe">
          <Plus className="size-5" />
        </Button>
      </form>

      {groups === undefined ? (
        <ul className="space-y-2" aria-hidden="true">
          {[0, 1].map((i) => (
            <li key={i} className="h-[4.75rem] animate-pulse rounded-xl bg-muted" />
          ))}
        </ul>
      ) : groups.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
            <Users className="size-6" />
          </div>
          <p className="text-sm text-muted-foreground text-balance">
            Aucun groupe pour l'instant. Creez-en un ci-dessus, ou rejoignez celui d'un ami avec son code.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {groups.map(({ group, members, totalCents, expenseCount, recentEmojis }) => (
            <li key={group.id}>
              <Link to={`/g/${group.id}`} className="block">
                <Card className="relative flex cursor-pointer items-center gap-3 overflow-hidden p-4 pl-5 transition-colors active:bg-accent">
                  {/* Accent edge in the group's stable colour (same hash as avatars) */}
                  <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: avatarColor(group.id) }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{group.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {recentEmojis.length > 0 && <span className="mr-1.5 text-sm">{recentEmojis.join(' ')}</span>}
                      {members.length} participant{members.length > 1 ? 's' : ''}
                      {expenseCount > 0 && ` · ${formatCents(totalCents, group.currency)}`}
                    </p>
                  </div>
                  {members.length > 0 && (
                    <div className="flex -space-x-2">
                      {members.slice(0, 3).map((m) => (
                        <MemberAvatar key={m.id} name={m.name} seed={m.id} size="xs" />
                      ))}
                      {members.length > 3 && (
                        <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-background">
                          +{members.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Join by code */}
      <div className="mt-8 border-t pt-6">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Rejoindre un groupe</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleJoin(joinCode)
          }}
          className="flex gap-2"
        >
          <Input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Code de partage"
            aria-label="Code de partage"
            autoCapitalize="characters"
          />
          <Button type="submit" size="icon" variant="outline" disabled={joining || !joinCode.trim()} aria-label="Rejoindre">
            <LogIn className="size-5" />
          </Button>
        </form>
      </div>

      <InstallHelpDialog open={installHelpOpen} onOpenChange={setInstallHelpOpen} />
    </main>
  )
}
