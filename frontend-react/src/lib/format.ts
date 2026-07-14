/** Format integer cents as a localized currency string, e.g. 1250 -> "12,50 €". */
export function formatCents(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100)
}

/**
 * Parse a user-typed amount ("12,50", "12.5", "12") into integer cents.
 * Returns null if it is not a valid non-negative number.
 */
export function parseAmountToCents(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.')
  if (normalized === '' || !/^\d*\.?\d*$/.test(normalized)) return null
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

export function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(d)
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Human day header for list sections: "Aujourd'hui", "Hier", otherwise
 * "13 juillet" (with the year when it is not the current one).
 */
export function dayLabel(iso: string, today: string = todayIso()): string {
  if (iso === today) return "Aujourd'hui"
  const d = new Date(iso + 'T00:00:00')
  const t = new Date(today + 'T00:00:00')
  if (Number.isNaN(d.getTime()) || Number.isNaN(t.getTime())) return iso
  if (Math.round((t.getTime() - d.getTime()) / 86_400_000) === 1) return 'Hier'
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }
  if (d.getFullYear() !== t.getFullYear()) opts.year = 'numeric'
  return new Intl.DateTimeFormat('fr-FR', opts).format(d)
}
