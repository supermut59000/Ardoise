import { describe, it, expect } from 'vitest'
import { computeBalances, referencedMemberIds } from './balances'
import { simplifyDebts } from './simplify-debts'
import type { Expense, Member, Settlement } from './types'

let c = 0
const member = (id: string): Member => ({ id, groupId: 'g', name: id, createdAt: c++ })
const expense = (paidBy: string, amountCents: number, ids: string[], over: Partial<Expense> = {}): Expense => ({
  id: `e${c++}`,
  groupId: 'g',
  description: 'x',
  amountCents,
  paidBy,
  spentAt: '2026-07-13',
  splitMode: 'equal',
  shares: ids.map((memberId) => ({ memberId, weight: 1 })),
  createdAt: c++,
  ...over,
})
const settlement = (from: string, to: string, amountCents: number, over: Partial<Settlement> = {}): Settlement => ({
  id: `s${c++}`,
  groupId: 'g',
  fromMemberId: from,
  toMemberId: to,
  amountCents,
  settledAt: '2026-07-14',
  createdAt: c++,
  ...over,
})

const net = (bs: { memberId: string; netCents: number }[], id: string) =>
  bs.find((b) => b.memberId === id)!.netCents
const total = (bs: { netCents: number }[]) => bs.reduce((a, b) => a + b.netCents, 0)

describe('settlements in balances', () => {
  it('a full settlement clears the debt to zero', () => {
    const members = [member('a'), member('b')]
    // a paid 100 for both -> b owes 50
    const expenses = [expense('a', 100, ['a', 'b'])]
    const before = computeBalances(members, expenses)
    expect(net(before, 'b')).toBe(-50)

    // b pays a back 50
    const after = computeBalances(members, expenses, [settlement('b', 'a', 50)])
    expect(net(after, 'a')).toBe(0)
    expect(net(after, 'b')).toBe(0)
    expect(simplifyDebts(after)).toEqual([])
  })

  it('a partial settlement reduces the remaining transfer', () => {
    const members = [member('a'), member('b')]
    const expenses = [expense('a', 100, ['a', 'b'])] // b owes 50
    const after = computeBalances(members, expenses, [settlement('b', 'a', 20)])
    expect(net(after, 'b')).toBe(-30)
    const transfers = simplifyDebts(after)
    expect(transfers).toEqual([{ fromMemberId: 'b', toMemberId: 'a', amountCents: 30 }])
  })

  it('balances still sum to zero with settlements applied', () => {
    const members = [member('a'), member('b'), member('c')]
    const expenses = [expense('a', 900, ['a', 'b', 'c'])]
    const after = computeBalances(members, expenses, [settlement('b', 'a', 100), settlement('c', 'a', 300)])
    expect(total(after)).toBe(0)
  })

  it('a deleted settlement has no effect', () => {
    const members = [member('a'), member('b')]
    const expenses = [expense('a', 100, ['a', 'b'])]
    const after = computeBalances(members, expenses, [settlement('b', 'a', 50, { deleted: true })])
    expect(net(after, 'b')).toBe(-50) // unchanged
  })
})

describe('referencedMemberIds (guard for member removal)', () => {
  it('flags the payer and every participant of a live expense', () => {
    const ids = referencedMemberIds([expense('a', 90, ['b', 'c'])])
    expect(ids.has('a')).toBe(true) // payer
    expect(ids.has('b')).toBe(true)
    expect(ids.has('c')).toBe(true)
  })

  it('flags both parties of a settlement', () => {
    const ids = referencedMemberIds([], [settlement('x', 'y', 100)])
    expect(ids.has('x')).toBe(true)
    expect(ids.has('y')).toBe(true)
  })

  it('ignores deleted expenses and settlements', () => {
    const ids = referencedMemberIds(
      [expense('a', 100, ['a', 'b'], { deleted: true })],
      [settlement('c', 'd', 50, { deleted: true })],
    )
    expect(ids.size).toBe(0)
  })

  it('a member in no expense is removable (not referenced)', () => {
    const ids = referencedMemberIds([expense('a', 100, ['a', 'b'])])
    expect(ids.has('lonely')).toBe(false)
  })
})
