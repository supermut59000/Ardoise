/** Format integer cents as a localized currency string, e.g. 1250 -> "12,50 €". */
export function formatCents(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100)
}

/**
 * Parse a user-typed amount ("12,50", "12.5", "12") into integer cents.
 * Returns null if it is not a valid non-negative number, or if it carries more
 * than two decimals: money has cents, not thousandths, and a third decimal
 * would round inconsistently through float math ("1,005" -> 1,00 instead of
 * 1,01), so it is rejected instead of silently mis-rounded.
 */
export function parseAmountToCents(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.')
  if (normalized === '' || !/^\d*\.?\d*$/.test(normalized)) return null
  if (normalized.includes('.') && normalized.split('.')[1].length > 2) return null
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

/**
 * Cap a user-typed number at two decimal digits as they type ("4,005" ->
 * "4,00"), so a third decimal never reaches the money math. Preserves the
 * separator the user typed (French comma or dot) and mid-edit states ("12,").
 */
export function limitTwoDecimals(input: string): string {
  const sep = input.includes(',') ? ',' : '.'
  const [int, frac] = input.split(sep)
  if (frac === undefined || frac.length <= 2) return input
  return `${int}${sep}${frac.slice(0, 2)}`
}

export function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(d)
}

/** Today's date in the DEVICE's timezone (never toISOString, which is UTC: at
 *  00:30 in Paris it would still say yesterday). */
export function todayIso(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * Human day header for list sections: "Aujourd'hui", "Hier", otherwise the
 * full date with the year ("25 mars 2026").
 */
export function dayLabel(iso: string, today: string = todayIso()): string {
  if (iso === today) return "Aujourd'hui"
  const d = new Date(iso + 'T00:00:00')
  const t = new Date(today + 'T00:00:00')
  if (Number.isNaN(d.getTime()) || Number.isNaN(t.getTime())) return iso
  if (Math.round((t.getTime() - d.getTime()) / 86_400_000) === 1) return 'Hier'
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}
