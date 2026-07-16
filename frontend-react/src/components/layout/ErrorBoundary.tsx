import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

/**
 * Last-resort containment: without it, any uncaught render error is a silent
 * white screen. Friends must never see a raw error (D22), so the fallback is a
 * calm French message and a reload button. Local data is safe either way: the
 * op log lives in IndexedDB and reloading only re-renders it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only: the user-facing surface is the fallback below.
    console.error('Ardoise render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Oups, quelque chose s'est mal passe</h1>
        <p className="text-sm text-muted-foreground text-balance">
          Vos donnees sont en securite sur cet appareil. Rechargez l'application pour continuer.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Recharger
        </button>
      </main>
    )
  }
}
