import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Wallet, ChevronRight, Menu, Sun, Moon, Download, LogIn, DownloadCloud, KeyRound } from 'lucide-react'
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
import { useGroups } from '@/hooks/use-groups'
import { useInstallPrompt } from '@/hooks/use-install-prompt'
import { createGroup } from '@/sync/ops'
import { joinGroup } from '@/sync/engine'
import { SyncError } from '@/sync/client'
import { promptForApiKey } from '@/lib/auth'
import { exportAllJson } from '@/lib/export'

export function Groups() {
  const groups = useGroups()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { resolvedTheme, setTheme } = useTheme()
  const { isStandalone, canInstall, isIOS, promptInstall } = useInstallPrompt()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [installHelpOpen, setInstallHelpOpen] = useState(false)
  const isDark = resolvedTheme === 'dark'
  const autoJoined = useRef(false)
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
      navigate(`/g/${groupId}`)
    } catch (e) {
      if (e instanceof SyncError && e.status === 401) {
        promptForApiKey()
      } else {
        toast.error('Code invalide ou serveur injoignable')
      }
    } finally {
      setJoining(false)
    }
  }

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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      await createGroup({ name: trimmed })
      setName('')
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
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { void exportAllJson() }}>
              <Download /> Exporter toutes les donnees (JSON)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        <p className="text-muted-foreground text-sm">Chargement...</p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Aucun groupe pour l'instant. Creez-en un ou rejoignez-en un avec un code.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li key={g.id}>
              <Link to={`/g/${g.id}`}>
                <Card className="flex items-center justify-between p-4 transition-colors active:bg-accent">
                  <span className="font-medium">{g.name}</span>
                  <ChevronRight className="size-5 text-muted-foreground" />
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
