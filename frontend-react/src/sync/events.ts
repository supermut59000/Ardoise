/** Fired after a local operation is written, so sync can push it near-instantly. */
export const LOCAL_CHANGE_EVENT = 'ardoise:local-change'

export function emitLocalChange(): void {
  // Guarded so the op layer stays usable under Node (tests) with no window.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LOCAL_CHANGE_EVENT))
  }
}
