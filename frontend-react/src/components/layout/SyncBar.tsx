import { CloudOff, RefreshCw } from 'lucide-react'

interface Props {
  online: boolean
  syncing: boolean
}

/** Thin status bar: shows offline persistently, a brief syncing hint otherwise. */
export function SyncBar({ online, syncing }: Props) {
  if (online && !syncing) return null

  return (
    <div
      className={`fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 py-1 text-center text-xs font-medium ${
        online ? 'bg-muted text-muted-foreground' : 'bg-amber-500 text-black'
      }`}
      style={{ paddingTop: 'max(env(safe-area-inset-top), 0.25rem)' }}
      role="status"
    >
      {online ? (
        <>
          <RefreshCw className="size-3 animate-spin" /> Synchronisation...
        </>
      ) : (
        <>
          <CloudOff className="size-3" /> Hors ligne, les modifications seront synchronisees plus tard
        </>
      )}
    </div>
  )
}
