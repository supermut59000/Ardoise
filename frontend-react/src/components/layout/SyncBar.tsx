import { CloudOff, RefreshCw, CloudUpload } from 'lucide-react'

interface Props {
  online: boolean
  syncing: boolean
  pending: number
}

/**
 * Quiet status strip. No technical errors ever reach the user: offline shows a
 * calm banner, syncing a subtle hint, and pending changes a reassuring count so
 * they know their edits are saved and on their way (never a silent failure).
 */
export function SyncBar({ online, syncing, pending }: Props) {
  if (online && !syncing && pending === 0) return null

  let content
  let tone = 'bg-muted text-muted-foreground'
  if (!online) {
    tone = 'bg-amber-500 text-black'
    content = (
      <>
        <CloudOff className="size-3" /> Hors ligne, vos modifications sont enregistrees
      </>
    )
  } else if (syncing) {
    content = (
      <>
        <RefreshCw className="size-3 animate-spin" /> Synchronisation...
      </>
    )
  } else {
    content = (
      <>
        <CloudUpload className="size-3" /> {pending} modification{pending > 1 ? 's' : ''} en attente
      </>
    )
  }

  return (
    <div
      className={`fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 py-1 text-center text-xs font-medium ${tone}`}
      style={{ paddingTop: 'max(env(safe-area-inset-top), 0.25rem)' }}
      role="status"
    >
      {content}
    </div>
  )
}
