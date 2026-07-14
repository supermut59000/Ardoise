import { describe, it, expect, beforeEach } from 'vitest'
import { ArdoiseDB, ingestOps } from '@/db/dexie'
import { foldOps } from './fold'
import {
  addExpense,
  addMember,
  createGroup,
  deleteExpense,
  updateExpense,
} from './ops'
import type { Operation } from './operation'

let db: ArdoiseDB
let counter = 0

async function foldDb(database: ArdoiseDB) {
  return foldOps(await database.operations.toArray())
}

beforeEach(async () => {
  // Fresh, uniquely-named DB per test so fake-indexeddb state never leaks.
  db = new ArdoiseDB(`test-${counter++}`)
  await db.open()
})

describe('ops layer: happy path', () => {
  it('creates a group, member and expense, visible in the fold', async () => {
    const groupId = await createGroup({ name: 'Weekend' }, db)
    const alice = await addMember(groupId, 'Alice', db)
    const bob = await addMember(groupId, 'Bob', db)
    await addExpense(
      groupId,
      {
        description: 'Courses',
        amountCents: 3000,
        paidBy: alice,
        spentAt: '2026-07-13',
        shares: [
          { memberId: alice, weight: 1 },
          { memberId: bob, weight: 1 },
        ],
      },
      db,
    )

    const state = await foldDb(db)
    expect(state.groups[groupId].name).toBe('Weekend')
    expect(Object.values(state.members).map((m) => m.name).sort()).toEqual(['Alice', 'Bob'])
    const expense = Object.values(state.expenses)[0]
    expect(expense).toMatchObject({ description: 'Courses', amountCents: 3000, paidBy: alice })
  })

  it('edits an expense via an update op', async () => {
    const groupId = await createGroup({ name: 'G' }, db)
    const a = await addMember(groupId, 'A', db)
    const id = await addExpense(
      groupId,
      { description: 'x', amountCents: 100, paidBy: a, spentAt: '2026-07-13', shares: [{ memberId: a, weight: 1 }] },
      db,
    )
    await updateExpense(groupId, id, { amountCents: 250, description: 'y' }, db)

    const state = await foldDb(db)
    expect(state.expenses[id]).toMatchObject({ amountCents: 250, description: 'y' })
  })

  it('deletes an expense (tombstone, gone from active list)', async () => {
    const groupId = await createGroup({ name: 'G' }, db)
    const a = await addMember(groupId, 'A', db)
    const id = await addExpense(
      groupId,
      { description: 'x', amountCents: 100, paidBy: a, spentAt: '2026-07-13', shares: [{ memberId: a, weight: 1 }] },
      db,
    )
    await deleteExpense(groupId, id, db)

    const state = await foldDb(db)
    expect(state.expenses[id].deleted).toBe(true)
  })
})

describe('ops layer: lamport clock', () => {
  it('assigns strictly increasing lamports to every op', async () => {
    const groupId = await createGroup({ name: 'G' }, db)
    const a = await addMember(groupId, 'A', db)
    for (let i = 0; i < 20; i++) {
      await addExpense(
        groupId,
        { description: `e${i}`, amountCents: i * 100, paidBy: a, spentAt: '2026-07-13', shares: [{ memberId: a, weight: 1 }] },
        db,
      )
    }
    const lamports = (await db.operations.toArray()).map((o) => o.lamport).sort((x, y) => x - y)
    // strictly increasing, no duplicates, no gaps
    for (let i = 1; i < lamports.length; i++) {
      expect(lamports[i]).toBe(lamports[i - 1] + 1)
    }
  })

  it('keeps a stable device id across many ops', async () => {
    const groupId = await createGroup({ name: 'G' }, db)
    await addMember(groupId, 'A', db)
    const actors = new Set((await db.operations.toArray()).map((o) => o.actor))
    expect(actors.size).toBe(1)
  })
})

describe('ops layer: rapid back-to-back writes (no lost/duplicated ticks)', () => {
  it('assigns a unique lamport to each of many concurrent appends', async () => {
    const groupId = await createGroup({ name: 'G' }, db)
    const a = await addMember(groupId, 'A', db)
    // Fire many expense writes without awaiting between them.
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        addExpense(
          groupId,
          { description: `e${i}`, amountCents: 100, paidBy: a, spentAt: '2026-07-13', shares: [{ memberId: a, weight: 1 }] },
          db,
        ),
      ),
    )
    const ops = await db.operations.toArray()
    const lamports = ops.map((o) => o.lamport)
    expect(new Set(lamports).size).toBe(lamports.length) // all unique
    expect(new Set(ops.map((o) => o.opId)).size).toBe(ops.length) // all unique op ids
  })
})

describe('ops layer: durability across reopen', () => {
  it('persists operations when the DB is closed and reopened', async () => {
    const name = `persist-${counter++}`
    const first = new ArdoiseDB(name)
    await first.open()
    const groupId = await createGroup({ name: 'Persisted' }, first)
    await addMember(groupId, 'A', first)
    first.close()

    const second = new ArdoiseDB(name)
    await second.open()
    const state = foldOps(await second.operations.toArray())
    expect(state.groups[groupId].name).toBe('Persisted')
    second.close()
  })
})

describe('ops layer: two-device offline merge (network simulation)', () => {
  it('two devices editing offline converge when their logs are merged', async () => {
    // Device 1 and device 2 both start from the same seed group/members, then
    // each makes an independent OFFLINE edit. Merging both logs (as Phase 2 sync
    // will) must converge to one state on both devices.
    const dev1 = new ArdoiseDB(`dev1-${counter++}`)
    const dev2 = new ArdoiseDB(`dev2-${counter++}`)
    await dev1.open()
    await dev2.open()

    // Seed identical starting ops on both (as if already synced once).
    const groupId = await createGroup({ name: 'Shared' }, dev1)
    const alice = await addMember(groupId, 'Alice', dev1)
    const bob = await addMember(groupId, 'Bob', dev1)
    const expenseId = await addExpense(
      groupId,
      { description: 'Hotel', amountCents: 10000, paidBy: alice, spentAt: '2026-07-13', shares: [{ memberId: alice, weight: 1 }, { memberId: bob, weight: 1 }] },
      dev1,
    )
    const seed = await dev1.operations.toArray()
    await ingestOps(dev2, seed) // realistic sync: advances dev2's clock past the seed

    // Offline divergence: device 1 edits the amount, device 2 deletes it.
    await updateExpense(groupId, expenseId, { amountCents: 12000 }, dev1)
    await deleteExpense(groupId, expenseId, dev2)

    // Merge each other's new ops (order intentionally different per device).
    const dev1New = (await dev1.operations.toArray()).filter((o) => !seed.some((s) => s.opId === o.opId))
    const dev2New = (await dev2.operations.toArray()).filter((o) => !seed.some((s) => s.opId === o.opId))
    await ingestOps(dev2, dev1New)
    await ingestOps(dev1, dev2New)

    const state1 = foldOps(await dev1.operations.toArray())
    const state2 = foldOps(await dev2.operations.toArray())

    // Both devices agree, and delete beat the concurrent edit.
    expect(state1).toEqual(state2)
    expect(state1.expenses[expenseId].deleted).toBe(true)

    dev1.close()
    dev2.close()
  })

  it('re-merging already-seen ops is idempotent (safe repeated sync)', async () => {
    const groupId = await createGroup({ name: 'G' }, db)
    await addMember(groupId, 'A', db)
    const ops: Operation[] = await db.operations.toArray()
    const before = foldOps(ops)
    // Simulate pulling the same ops again; bulkPut is a no-op on identical PKs.
    await db.operations.bulkPut(ops)
    const after = foldOps(await db.operations.toArray())
    expect(after).toEqual(before)
    expect((await db.operations.toArray()).length).toBe(ops.length)
  })
})
