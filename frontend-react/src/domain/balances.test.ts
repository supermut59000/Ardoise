import { describe, it, expect } from 'vitest'
import { computeBalances } from './balances'
import { simplifyDebts } from './simplify-debts'
import type { Balance, Expense, Member } from './types'

let idc = 0
const member = (id: string, over: Partial<Member> = {}): Member => ({
  id,
  groupId: 'g',
  name: id,
  createdAt: idc++,
  ...over,
})
const equalExpense = (
  paidBy: string,
  amountCents: number,
  participants: string[],
  over: Partial<Expense> = {},
): Expense => ({
  id: `e${idc++}`,
  groupId: 'g',
  description: 'x',
  amountCents,
  paidBy,
  spentAt: '2026-07-13',
  shares: participants.map((memberId) => ({ memberId, weight: 1 })),
  createdAt: idc++,
  ...over,
})

const netOf = (bs: Balance[], id: string) => bs.find((b) => b.memberId === id)!.netCents
const sumNet = (bs: Balance[]) => bs.reduce((a, b) => a + b.netCents, 0)

describe('computeBalances', () => {
  it('credits the payer and debits participants', () => {
    const members = [member('a'), member('b'), member('c')]
    const bs = computeBalances(members, [equalExpense('a', 3000, ['a', 'b', 'c'])])
    expect(netOf(bs, 'a')).toBe(2000)
    expect(netOf(bs, 'b')).toBe(-1000)
    expect(netOf(bs, 'c')).toBe(-1000)
  })

  it('always sums to zero, even with an uneven split', () => {
    const members = [member('a'), member('b'), member('c')]
    const bs = computeBalances(members, [equalExpense('a', 100, ['a', 'b', 'c'])])
    expect(sumNet(bs)).toBe(0)
  })

  it('handles a payer who did not participate in the expense', () => {
    const members = [member('a'), member('b'), member('c')]
    // a pays 90 but only b and c consume it
    const bs = computeBalances(members, [equalExpense('a', 90, ['b', 'c'])])
    expect(netOf(bs, 'a')).toBe(90)
    expect(netOf(bs, 'b')).toBe(-45)
    expect(netOf(bs, 'c')).toBe(-45)
    expect(sumNet(bs)).toBe(0)
  })

  it('excludes deleted expenses', () => {
    const members = [member('a'), member('b')]
    const bs = computeBalances(members, [
      equalExpense('a', 1000, ['a', 'b']),
      equalExpense('a', 5000, ['a', 'b'], { deleted: true }),
    ])
    expect(netOf(bs, 'a')).toBe(500)
    expect(netOf(bs, 'b')).toBe(-500)
  })

  it('gives a member with no activity a zero balance', () => {
    const members = [member('a'), member('b'), member('lonely')]
    const bs = computeBalances(members, [equalExpense('a', 1000, ['a', 'b'])])
    expect(netOf(bs, 'lonely')).toBe(0)
  })

  it('sums to zero across many random expenses (property)', () => {
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const members = ['a', 'b', 'c', 'd', 'e'].map((x) => member(x))
    const ids = members.map((m) => m.id)
    for (let trial = 0; trial < 200; trial++) {
      const expenses: Expense[] = []
      const count = 1 + Math.floor(rand() * 10)
      for (let k = 0; k < count; k++) {
        const payer = ids[Math.floor(rand() * ids.length)]
        const participants = ids.filter(() => rand() > 0.4)
        if (participants.length === 0) participants.push(payer)
        expenses.push(equalExpense(payer, Math.floor(rand() * 20000), participants))
      }
      expect(sumNet(computeBalances(members, expenses))).toBe(0)
    }
  })
})

describe('simplifyDebts', () => {
  it('produces no transfers when everyone is settled', () => {
    expect(simplifyDebts([{ memberId: 'a', netCents: 0 }])).toEqual([])
  })

  it('settles a classic 3-person case with 2 transfers', () => {
    const balances: Balance[] = [
      { memberId: 'a', netCents: 2000 },
      { memberId: 'b', netCents: -1000 },
      { memberId: 'c', netCents: -1000 },
    ]
    const transfers = simplifyDebts(balances)
    expect(transfers.length).toBe(2)
    // everyone ends at zero after applying transfers
    const settled = new Map(balances.map((b) => [b.memberId, b.netCents]))
    for (const t of transfers) {
      settled.set(t.fromMemberId, settled.get(t.fromMemberId)! + t.amountCents)
      settled.set(t.toMemberId, settled.get(t.toMemberId)! - t.amountCents)
    }
    for (const v of settled.values()) expect(v).toBe(0)
  })

  it('never emits more than n-1 transfers and always reconciles (property)', () => {
    let seed = 99
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rand() * 6)
      const raw = Array.from({ length: n }, (_, i) => ({
        memberId: `m${i}`,
        netCents: Math.floor(rand() * 20000) - 10000,
      }))
      // force sum to zero by absorbing the remainder into the last member
      const drift = raw.reduce((a, b) => a + b.netCents, 0)
      raw[raw.length - 1].netCents -= drift

      const transfers = simplifyDebts(raw)
      expect(transfers.length).toBeLessThanOrEqual(n - 1)

      const settled = new Map(raw.map((b) => [b.memberId, b.netCents]))
      for (const t of transfers) {
        expect(t.amountCents).toBeGreaterThan(0)
        settled.set(t.fromMemberId, settled.get(t.fromMemberId)! + t.amountCents)
        settled.set(t.toMemberId, settled.get(t.toMemberId)! - t.amountCents)
      }
      for (const v of settled.values()) expect(v).toBe(0)
    }
  })

  it('is deterministic regardless of input order', () => {
    const a: Balance[] = [
      { memberId: 'a', netCents: 500 },
      { memberId: 'b', netCents: 500 },
      { memberId: 'c', netCents: -1000 },
    ]
    const b = [...a].reverse()
    expect(simplifyDebts(a)).toEqual(simplifyDebts(b))
  })
})
