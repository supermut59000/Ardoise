import type { Balance, Expense, Member, Settlement } from './types'
import { computeOwed } from './split'

/**
 * Net position per member for a group: what they paid minus what they owe,
 * adjusted for recorded settlements. Positive = the group owes them; negative =
 * they owe the group.
 *
 * Deleted expenses/members/settlements are ignored. Expenses conserve their
 * total and settlements move equal-and-opposite amounts, so the sum of all
 * balances is always exactly zero.
 */
export function computeBalances(
  members: Member[],
  expenses: Expense[],
  settlements: Settlement[] = [],
): Balance[] {
  const net = new Map<string, number>()
  for (const m of members) {
    if (!m.deleted) net.set(m.id, 0)
  }

  for (const e of expenses) {
    if (e.deleted) continue
    net.set(e.paidBy, (net.get(e.paidBy) ?? 0) + e.amountCents)
    const owed = computeOwed(e.amountCents, e.splitMode, e.shares)
    for (const [memberId, cents] of owed) {
      net.set(memberId, (net.get(memberId) ?? 0) - cents)
    }
  }

  // A settlement: `from` handed `to` cash, so `from` owes that much less
  // (net up) and `to` is owed that much less (net down).
  for (const s of settlements) {
    if (s.deleted) continue
    net.set(s.fromMemberId, (net.get(s.fromMemberId) ?? 0) + s.amountCents)
    net.set(s.toMemberId, (net.get(s.toMemberId) ?? 0) - s.amountCents)
  }

  return [...net.entries()].map(([memberId, netCents]) => ({ memberId, netCents }))
}

/**
 * One member's share of consumption across all non-deleted expenses ("Ma part"):
 * the sum of what the splits attribute to them, regardless of who paid.
 * Uses the same computeOwed as balances, so it is remainder-exact in cents.
 */
export function memberShareCents(expenses: Expense[], memberId: string): number {
  let total = 0
  for (const e of expenses) {
    if (e.deleted) continue
    total += computeOwed(e.amountCents, e.splitMode, e.shares).get(memberId) ?? 0
  }
  return total
}

/**
 * Member ids that still appear in a non-deleted expense (as payer or participant)
 * or settlement. Removing one of these would orphan the references and leave a
 * nameless ghost in the balances, so the UI blocks it.
 */
export function referencedMemberIds(
  expenses: Expense[],
  settlements: Settlement[] = [],
): Set<string> {
  const ids = new Set<string>()
  for (const e of expenses) {
    if (e.deleted) continue
    ids.add(e.paidBy)
    for (const s of e.shares) ids.add(s.memberId)
  }
  for (const s of settlements) {
    if (s.deleted) continue
    ids.add(s.fromMemberId)
    ids.add(s.toMemberId)
  }
  return ids
}
