import type { ExpenseShare, SplitMode } from './types'

/**
 * Split an integer-cent amount across weighted shares, returning the exact cents
 * owed per member. The sum of the result ALWAYS equals `amountCents` (no cent is
 * ever created or lost): the rounding remainder is handed out one cent at a time,
 * to the largest fractional parts first, ties broken by the shares' given order.
 *
 * Works for equal splits (all weights 1) and future weighted/exact splits.
 * Negative amounts (refunds) are supported and split with the same guarantee.
 */
export function splitCents(
  amountCents: number,
  shares: ExpenseShare[],
): Map<string, number> {
  const result = new Map<string, number>()
  if (shares.length === 0) return result

  const totalWeight = shares.reduce((sum, s) => sum + s.weight, 0)

  // Degenerate weights (all zero / negative total): fall back to equal split so
  // we never divide by zero and still conserve the total.
  if (totalWeight <= 0) {
    return splitCents(
      amountCents,
      shares.map((s) => ({ memberId: s.memberId, weight: 1 })),
    )
  }

  const sign = amountCents < 0 ? -1 : 1
  const magnitude = Math.abs(amountCents)

  // Exact floor allocation per share, plus the fractional remainder we owe.
  const floors: number[] = []
  const remainders: number[] = []
  let allocated = 0
  for (const share of shares) {
    const exact = (magnitude * share.weight) / totalWeight
    const floor = Math.floor(exact)
    floors.push(floor)
    remainders.push(exact - floor)
    allocated += floor
  }

  let leftover = magnitude - allocated // number of extra cents to distribute

  // Give the leftover cents to the largest fractional parts first. Stable:
  // equal remainders keep the shares' original order, so the result is
  // deterministic across devices.
  const order = shares
    .map((_, i) => i)
    .sort((a, b) => remainders[b] - remainders[a] || a - b)

  for (let k = 0; k < order.length && leftover > 0; k++) {
    floors[order[k]] += 1
    leftover--
  }

  shares.forEach((share, i) => {
    result.set(share.memberId, sign * floors[i])
  })
  return result
}

/** Convenience: equal split across member ids. */
export function splitEqual(
  amountCents: number,
  memberIds: string[],
): Map<string, number> {
  return splitCents(
    amountCents,
    memberIds.map((memberId) => ({ memberId, weight: 1 })),
  )
}

/**
 * Cents owed per member for an expense, honoring its split mode.
 *   equal/shares/percent -> proportional to weights (splitCents conserves total)
 *   exact                -> the weight IS the cents owed, used verbatim
 * An absent mode means equal (Phase 1 expenses).
 */
export function computeOwed(
  amountCents: number,
  mode: SplitMode | undefined,
  shares: ExpenseShare[],
): Map<string, number> {
  if (mode === 'exact') {
    const result = new Map<string, number>()
    for (const s of shares) result.set(s.memberId, s.weight)
    return result
  }
  return splitCents(amountCents, shares)
}

/**
 * Which parts are pinned, and therefore which members absorb the rest.
 *
 * The rule that makes the editor feel right: as soon as the user types ONE
 * part, the parts an edited expense was saved with stop being pinned, so the
 * members left alone go back to absorbing the remainder. Without it, opening a
 * saved 60/40 expense and typing "30" would leave the other part at 60 and
 * demand mental arithmetic, which is exactly the friction this replaces.
 *
 * `typed` holds parsed values keyed by member: a key that is present but null
 * (field cleared, half-typed) still counts as "the user has taken over", but
 * that member is not pinned to a value. `saved` is the edited expense's own
 * split, used only while nothing has been typed.
 */
export function pinnedParts(
  selected: string[],
  typed: Record<string, number | null>,
  saved: Record<string, number> | null,
): Map<string, number> {
  const pinned = new Map<string, number>()
  const userTookOver = Object.keys(typed).length > 0
  for (const memberId of selected) {
    if (userTookOver) {
      const value = typed[memberId]
      if (value !== undefined && value !== null) pinned.set(memberId, value)
    } else if (saved && saved[memberId] !== undefined) {
      pinned.set(memberId, saved[memberId])
    }
  }
  return pinned
}

/**
 * Fill in the parts the user did NOT type, so nobody has to compute a
 * complement by hand: "Bob 40 %" must not force the user to work out that
 * Alice owes 60, or that three people share the remaining 60 as 20/20/20.
 *
 * `total` and `fixed` share one unit: centi-percent (10 000 = 100 %) for the
 * percent mode, cents for the exact mode. Every selected member absent from
 * `fixed` absorbs an equal slice of what is left, distributed by `splitCents`,
 * so the parts always add up to `total` exactly (no cent, no hundredth of a
 * percent, created or lost).
 *
 * When the typed parts already exceed the total, the absorbers get 0 and the
 * overflow surfaces through `validateSplit` rather than silently going
 * negative.
 */
export function distributeRemainder(
  total: number,
  selected: string[],
  fixed: Map<string, number>,
): Map<string, number> {
  const result = new Map<string, number>()
  const absorbers: string[] = []
  let fixedSum = 0

  for (const memberId of selected) {
    const value = fixed.get(memberId)
    if (value === undefined) {
      absorbers.push(memberId)
    } else {
      result.set(memberId, value)
      fixedSum += value
    }
  }

  if (absorbers.length === 0) return result

  const remainder = total - fixedSum
  if (remainder <= 0) {
    for (const memberId of absorbers) result.set(memberId, 0)
    return result
  }

  const shared = splitCents(
    remainder,
    absorbers.map((memberId) => ({ memberId, weight: 1 })),
  )
  for (const memberId of absorbers) result.set(memberId, shared.get(memberId) ?? 0)
  return result
}

/**
 * Validate a split before saving. Returns null if valid, otherwise a French
 * message. `amountCents` is the expense total (used by exact mode).
 */
export function validateSplit(
  mode: SplitMode,
  amountCents: number,
  shares: ExpenseShare[],
): string | null {
  if (shares.length === 0) return 'Selectionnez au moins un participant'

  const sum = shares.reduce((a, s) => a + s.weight, 0)
  if (mode === 'exact') {
    if (sum !== amountCents) {
      return 'La somme des montants doit egaler le total de la depense'
    }
  } else if (mode === 'percent') {
    // Decimal percentages are allowed (33,33 / 33,33 / 33,34): compare at
    // two-decimal precision, because 33.33 + 33.33 + 33.34 !== 100 in floating
    // point even though the user typed exactly 100.
    if (Math.round(sum * 100) !== 100_00) return 'Les pourcentages doivent totaliser 100'
  } else if (mode === 'shares') {
    if (shares.some((s) => !Number.isFinite(s.weight) || s.weight < 0)) {
      return 'Les parts doivent etre des nombres positifs'
    }
    if (shares.every((s) => s.weight === 0)) return 'Au moins une part doit etre positive'
  }
  return null
}
