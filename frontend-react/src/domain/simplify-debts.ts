import type { Balance, Transfer } from './types'

/**
 * Turn net balances into a minimal-ish set of "who pays whom" transfers, using a
 * greedy min-cash-flow match: repeatedly settle the largest debtor against the
 * largest creditor. This does not always find the theoretical minimum number of
 * transfers (that problem is NP-hard) but is optimal in practice and never
 * produces more than n-1 transfers for n people.
 *
 * Preconditions from `computeBalances`: balances are integer cents and sum to
 * zero. The returned transfers exactly reconcile every balance to zero.
 */
export function simplifyDebts(balances: Balance[]): Transfer[] {
  const debtors: { id: string; amount: number }[] = [] // owe money (negative net)
  const creditors: { id: string; amount: number }[] = [] // are owed (positive net)

  for (const b of balances) {
    if (b.netCents < 0) debtors.push({ id: b.memberId, amount: -b.netCents })
    else if (b.netCents > 0) creditors.push({ id: b.memberId, amount: b.netCents })
  }

  // Deterministic ordering: biggest first, ties broken by member id, so every
  // device computes the identical transfer list.
  const byAmountThenId = (a: { id: string; amount: number }, b: { id: string; amount: number }) =>
    b.amount - a.amount || a.id.localeCompare(b.id)
  debtors.sort(byAmountThenId)
  creditors.sort(byAmountThenId)

  const transfers: Transfer[] = []
  let i = 0
  let j = 0
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount)
    if (pay > 0) {
      transfers.push({
        fromMemberId: debtors[i].id,
        toMemberId: creditors[j].id,
        amountCents: pay,
      })
    }
    debtors[i].amount -= pay
    creditors[j].amount -= pay
    if (debtors[i].amount === 0) i++
    if (creditors[j].amount === 0) j++
  }

  return transfers
}
