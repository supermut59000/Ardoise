// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useAutomaticInvite } from './use-automatic-invite'

// React's act() needs this flag outside a test-renderer setup.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({ join }: { join: (code: string) => void }) {
  useAutomaticInvite(join)
  return null
}

function render(ui: React.ReactNode): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(ui)
  })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  // This jsdom setup exposes a bare localStorage object; stub a working one so
  // auth.ts (localStorage.setItem) and the assertions behave deterministically.
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => store.clear(),
    },
  })
})

describe('useAutomaticInvite', () => {
  it('joins from the QR fragment on mount and erases the credentials', () => {
    window.history.replaceState(null, '', '/#join=ABCD2345&key=secret')
    const join = vi.fn()

    render(<Harness join={join} />)

    expect(join).toHaveBeenCalledWith('ABCD2345')
    expect(window.localStorage.getItem('ardoise_api_key')).toBe('secret')
    // The shared password must not linger in the address bar.
    expect(window.location.hash).toBe('')
  })

  it('joins a QR invite that arrives via hashchange while the app is open', () => {
    // The regression this guards: the old mount-only effect ignored a fragment
    // that appeared AFTER the app was already open (a same-tab navigation to
    // /#join=... has no page reload), leaving the password in the address bar
    // and never joining.
    const join = vi.fn()
    render(<Harness join={join} />)
    expect(join).not.toHaveBeenCalled()

    window.location.hash = 'join=EFGH6789&key=autre'
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(join).toHaveBeenCalledWith('EFGH6789')
    expect(window.localStorage.getItem('ardoise_api_key')).toBe('autre')
    expect(window.location.hash).toBe('')
  })

  it('consumes at most one invite per session', () => {
    window.history.replaceState(null, '', '/#join=ABCD2345&key=first')
    const join = vi.fn()
    render(<Harness join={join} />)
    expect(join).toHaveBeenCalledTimes(1)

    window.location.hash = 'join=ZZZZ9999&key=second'
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(join).toHaveBeenCalledTimes(1)
  })
})
