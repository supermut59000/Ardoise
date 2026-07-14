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
    if (sum !== 100) return 'Les pourcentages doivent totaliser 100'
  } else if (mode === 'shares') {
    if (shares.every((s) => s.weight <= 0)) return 'Au moins une part doit etre positive'
  }
  return null
}
