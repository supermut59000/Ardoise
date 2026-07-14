import { Share, PlusSquare } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** iOS has no install event, so we show the manual steps. */
export function InstallHelpDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Installer Ardoise</DialogTitle>
        <DialogDescription>
          Ajoutez l'app a votre ecran d'accueil pour la lancer en plein ecran et garder vos donnees hors ligne.
        </DialogDescription>
        <ol className="space-y-3 text-sm">
          <li className="flex items-center gap-3">
            <Share className="size-5 shrink-0 text-primary" />
            <span>Touchez le bouton Partager dans la barre de Safari.</span>
          </li>
          <li className="flex items-center gap-3">
            <PlusSquare className="size-5 shrink-0 text-primary" />
            <span>Choisissez "Sur l'ecran d'accueil", puis Ajouter.</span>
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  )
}
