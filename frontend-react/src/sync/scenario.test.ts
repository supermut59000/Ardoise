import { describe, it, expect, beforeEach } from 'vitest'
import { ArdoiseDB } from '@/db/dexie'
import { activeExpenses, activeMembers, foldOps } from './fold'
import { computeBalances } from '@/domain/balances'
import { simplifyDebts } from '@/domain/simplify-debts'
import { activeSettlements } from './fold'
import { addExpense, addMember, addSettlement, createGroup, deleteExpense } from './ops'
import { formatCents } from '@/lib/format'

/**
 * End-to-end at the data layer: replays exactly the calls the UI makes
 * (Groups -> GroupDetail -> AddExpense) and asserts the balances + settle-up the
 * user would see. This is the money pipeline behind the screens.
 */
let db: ArdoiseDB
let n = 0
beforeEach(async () => {
  db = new ArdoiseDB(`scenario-${n++}`)
  await db.open()
})

async function view(groupId: string) {
  const state = foldOps(await db.operations.where('groupId').equals(groupId).toArray())
  const members = activeMembers(state, groupId)
  const expenses = activeExpenses(state, groupId)
  const settlements = activeSettlements(state, groupId)
  const balances = computeBalances(members, expenses, settlements)
  const transfers = simplifyDebts(balances)
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? '?'
  return { state, members, expenses, settlements, balances, transfers, name }
}

describe('user scenario: weekend split', () => {
  it('60 EUR paid by Alice, split 3 ways, settles to two 20 EUR transfers', async () => {
    const g = await createGroup({ name: 'Week-end Bretagne' }, db)
    const alice = await addMember(g, 'Alice', db)
    const bob = await addMember(g, 'Bob', db)
    const lea = await addMember(g, 'Lea', db)

    await addExpense(
      g,
      {
        description: 'Courses',
        amountCents: 6000,
        paidBy: alice,
        spentAt: '2026-07-13',
        shares: [alice, bob, lea].map((memberId) => ({ memberId, weight: 1 })),
      },
      db,
    )

    const { balances, transfers, name } = await view(g)
    const net = (id: string) => balances.find((b) => b.memberId === id)!.netCents

    expect(net(alice)).toBe(4000)
    expect(net(bob)).toBe(-2000)
    expect(net(lea)).toBe(-2000)

    // Two reimbursements, both to Alice, 20 EUR each.
    expect(transfers).toHaveLength(2)
    for (const t of transfers) {
      expect(t.toMemberId).toBe(alice)
      expect(t.amountCents).toBe(2000)
      expect(formatCents(t.amountCents)).toContain('20,00')
    }
    expect(transfers.map((t) => name(t.fromMemberId)).sort()).toEqual(['Bob', 'Lea'])
  })

  it('two expenses by different payers net out correctly', async () => {
    const g = await createGroup({ name: 'Coloc' }, db)
    const a = await addMember(g, 'A', db)
    const b = await addMember(g, 'B', db)

    // A pays 30 for both, then B pays 10 for both.
    await addExpense(g, { description: 'x', amountCents: 3000, paidBy: a, spentAt: '2026-07-13', shares: [a, b].map((m) => ({ memberId: m, weight: 1 })) }, db)
    await addExpense(g, { description: 'y', amountCents: 1000, paidBy: b, spentAt: '2026-07-13', shares: [a, b].map((m) => ({ memberId: m, weight: 1 })) }, db)

    const { balances, transfers } = await view(g)
    const net = (id: string) => balances.find((bal) => bal.memberId === id)!.netCents
    // A fronted 30 - owes 20 = +10; B fronted 10 - owes 20 = -10
    expect(net(a)).toBe(1000)
    expect(net(b)).toBe(-1000)
    expect(transfers).toEqual([{ fromMemberId: b, toMemberId: a, amountCents: 1000 }])
  })

  it('exact split then a settlement clears the debt', async () => {
    const g = await createGroup({ name: 'Resto' }, db)
    const a = await addMember(g, 'Alice', db)
    const b = await addMember(g, 'Bob', db)
    // Alice pays 30, but Bob only owes 10 exactly (Alice 20).
    await addExpense(
      g,
      {
        description: 'Resto',
        amountCents: 3000,
        paidBy: a,
        spentAt: '2026-07-13',
        splitMode: 'exact',
        shares: [{ memberId: a, weight: 2000 }, { memberId: b, weight: 1000 }],
      },
      db,
    )
    let v = await view(g)
    expect(v.balances.find((x) => x.memberId === b)!.netCents).toBe(-1000)
    expect(v.transfers).toEqual([{ fromMemberId: b, toMemberId: a, amountCents: 1000 }])

    // Bob settles the 10.
    await addSettlement(g, { fromMemberId: b, toMemberId: a, amountCents: 1000, settledAt: '2026-07-14' }, db)
    v = await view(g)
    expect(v.transfers).toHaveLength(0)
    expect(v.balances.every((x) => x.netCents === 0)).toBe(true)
    const settlements = activeSettlements(
      foldOps(await db.operations.where('groupId').equals(g).toArray()),
      g,
    )
    expect(settlements).toHaveLength(1)
  })

  it('deleting the only expense returns everyone to zero and clears reimbursements', async () => {
    const g = await createGroup({ name: 'G' }, db)
    const a = await addMember(g, 'A', db)
    const b = await addMember(g, 'B', db)
    const eId = await addExpense(g, { description: 'x', amountCents: 5000, paidBy: a, spentAt: '2026-07-13', shares: [a, b].map((m) => ({ memberId: m, weight: 1 })) }, db)

    let v = await view(g)
    expect(v.transfers).toHaveLength(1)

    await deleteExpense(g, eId, db)
    v = await view(g)
    expect(v.expenses).toHaveLength(0)
    expect(v.transfers).toHaveLength(0)
    expect(v.balances.every((bal) => bal.netCents === 0)).toBe(true)
  })
})
