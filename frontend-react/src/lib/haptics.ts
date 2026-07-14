/**
 * A tiny tactile confirmation for meaningful actions (add expense, settle).
 * No-op where unsupported (iOS Safari ignores it) and never on every tap.
 */
export function tapFeedback(): void {
  try {
    navigator.vibrate?.(10)
  } catch {
    /* unsupported */
  }
}
