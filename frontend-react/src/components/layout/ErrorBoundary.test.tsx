// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './ErrorBoundary'

// React's act() needs this flag outside a test-renderer setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Bomb(): never {
  throw new Error('boom')
}

function render(ui: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  return container
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    const container = render(
      <ErrorBoundary>
        <p>contenu normal</p>
      </ErrorBoundary>,
    )
    expect(container.textContent).toContain('contenu normal')
    expect(container.textContent).not.toContain('Recharger')
  })

  it('shows the French fallback instead of a white screen when a child throws', () => {
    // Silence React's expected error logging for the thrown render.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    errSpy.mockRestore()

    // The regression this guards: without a boundary the container would be
    // empty (React unmounts the whole tree) and a friend would see a white
    // screen with no way out.
    expect(container.textContent).toContain('Oups')
    expect(container.textContent).toContain('Vos donnees sont en securite')
    expect(container.textContent).toContain('Recharger')
  })
})
