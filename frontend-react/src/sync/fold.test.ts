import { describe, it, expect } from 'vitest'
import { foldOps } from './fold'
import type { Operation } from './operation'

let seq = 0
function op(over: Partial<Operation> & Pick<Operation, 'action'>): Operation {
  return {
    opId: over.opId ?? `op-${String(seq++).padStart(4, '0')}`,
    groupId: over.groupId ?? 'g1',
    entity: over.entity ?? 'expense',
    entityId: over.entityId ?? 'e1',
    action: over.action,
    payload: over.payload ?? {},
    actor: over.actor ?? 'devA',
    lamport: over.lamport ?? 1,
    createdAt: over.createdAt ?? 0,
    synced: 0,
  }
}

function shuffle<T>(arr: T[], seedStart: number): T[] {
  let s = seedStart
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

describe('foldOps: basic reduce', () => {
  it('creates an entity from a create op', () => {
    const state = foldOps([
      op({ action: 'create', entity: 'group', entityId: 'g1', payload: { name: 'Trip', currency: 'EUR', createdAt: 1 } }),
    ])
    expect(state.groups['g1']).toMatchObject({ id: 'g1', name: 'Trip', currency: 'EUR' })
  })

  it('merges update fields (LWW) onto a create', () => {
    const state = foldOps([
      op({ opId: 'a', lamport: 1, action: 'create', payload: { description: 'Old', createdAt: 1 } }),
      op({ opId: 'b', lamport: 2, action: 'update', payload: { description: 'New' } }),
    ])
    expect(state.expenses['e1']).toMatchObject({ description: 'New', createdAt: 1 })
  })
})

describe('foldOps: idempotency', () => {
  it('collapses duplicate opIds (replay is a no-op)', () => {
    const create = op({ opId: 'dup', action: 'create', payload: { amountCents: 100, createdAt: 1 } })
    const single = foldOps([create])
    const doubled = foldOps([create, { ...create }, { ...create }])
    expect(doubled).toEqual(single)
  })
})

describe('foldOps: last-writer-wins', () => {
  it('higher lamport wins regardless of array order', () => {
    const ops = [
      op({ opId: 'c', lamport: 1, action: 'create', payload: { description: 'A', createdAt: 1 } }),
      op({ opId: 'u1', lamport: 2, action: 'update', payload: { description: 'B' } }),
      op({ opId: 'u2', lamport: 3, action: 'update', payload: { description: 'C' } }),
    ]
    expect(foldOps(ops).expenses['e1'].description).toBe('C')
    expect(foldOps([...ops].reverse()).expenses['e1'].description).toBe('C')
  })

  it('same lamport ties break by opId, deterministically', () => {
    const create = op({ opId: 'aaa', lamport: 1, action: 'create', payload: { description: 'A', createdAt: 1 } })
    const uX = op({ opId: 'mmm', lamport: 5, action: 'update', payload: { description: 'X' } })
    const uY = op({ opId: 'zzz', lamport: 5, action: 'update', payload: { description: 'Y' } })
    // zzz > mmm, so uY is applied last and wins in any order
    expect(foldOps([create, uX, uY]).expenses['e1'].description).toBe('Y')
    expect(foldOps([uY, create, uX]).expenses['e1'].description).toBe('Y')
  })

  it('leaves omitted fields untouched (per-field merge)', () => {
    const state = foldOps([
      op({ opId: 'a', lamport: 1, action: 'create', payload: { description: 'A', amountCents: 500, createdAt: 1 } }),
      op({ opId: 'b', lamport: 2, action: 'update', payload: { amountCents: 700 } }),
    ])
    expect(state.expenses['e1']).toMatchObject({ description: 'A', amountCents: 700 })
  })
})

describe('foldOps: delete is terminal', () => {
  it('a later update cannot resurrect a deleted entity', () => {
    const state = foldOps([
      op({ opId: 'a', lamport: 1, action: 'create', payload: { description: 'A', createdAt: 1 } }),
      op({ opId: 'b', lamport: 2, action: 'delete' }),
      op({ opId: 'c', lamport: 3, action: 'update', payload: { description: 'Z' } }),
    ])
    expect(state.expenses['e1'].deleted).toBe(true)
    expect(state.expenses['e1'].description).toBe('A') // update after delete was dropped
  })

  it('delete beats a concurrent edit (same lamport), both orderings', () => {
    const create = op({ opId: 'a', lamport: 1, action: 'create', payload: { description: 'A', createdAt: 1 } })
    const edit = op({ opId: 'edit', lamport: 2, action: 'update', payload: { description: 'edited' } })
    const del = op({ opId: 'del', lamport: 2, action: 'delete' })
    expect(foldOps([create, edit, del]).expenses['e1'].deleted).toBe(true)
    expect(foldOps([create, del, edit]).expenses['e1'].deleted).toBe(true)
  })
})

describe('foldOps: malformed / out-of-order streams', () => {
  it('drops an orphan update whose create never arrived (no crash, no phantom)', () => {
    const state = foldOps([op({ action: 'update', entityId: 'ghost', payload: { name: 'X' } })])
    expect(state.expenses['ghost']).toBeUndefined()
    expect(Object.keys(state.expenses)).toHaveLength(0)
  })

  it('drops an orphan delete', () => {
    const state = foldOps([op({ action: 'delete', entityId: 'ghost' })])
    expect(state.expenses['ghost']).toBeUndefined()
  })

  it('handles an update sorted before its create (lower create lamport)', () => {
    // create has the smaller lamport, so after sorting it is applied first
    const state = foldOps([
      op({ opId: 'u', lamport: 9, action: 'update', payload: { description: 'after' } }),
      op({ opId: 'c', lamport: 1, action: 'create', payload: { description: 'before', createdAt: 1 } }),
    ])
    expect(state.expenses['e1']).toMatchObject({ description: 'after' })
  })
})

describe('foldOps: convergence (the multi-device / network guarantee)', () => {
  // A realistic mixed log: two devices, creates + edits + a delete.
  const log: Operation[] = [
    op({ opId: 'g', entity: 'group', entityId: 'g1', lamport: 1, actor: 'A', action: 'create', payload: { name: 'Trip', createdAt: 1 } }),
    op({ opId: 'm1', entity: 'member', entityId: 'm1', lamport: 2, actor: 'A', action: 'create', payload: { groupId: 'g1', name: 'Alice', createdAt: 2 } }),
    op({ opId: 'm2', entity: 'member', entityId: 'm2', lamport: 2, actor: 'B', action: 'create', payload: { groupId: 'g1', name: 'Bob', createdAt: 2 } }),
    op({ opId: 'e1c', entity: 'expense', entityId: 'e1', lamport: 3, actor: 'A', action: 'create', payload: { groupId: 'g1', amountCents: 3000, createdAt: 3 } }),
    op({ opId: 'e1u', entity: 'expense', entityId: 'e1', lamport: 5, actor: 'B', action: 'update', payload: { amountCents: 3500 } }),
    op({ opId: 'e2c', entity: 'expense', entityId: 'e2', lamport: 4, actor: 'B', action: 'create', payload: { groupId: 'g1', amountCents: 1200, createdAt: 4 } }),
    op({ opId: 'e2d', entity: 'expense', entityId: 'e2', lamport: 6, actor: 'A', action: 'delete' }),
    // A settlement that is later undone: exercises the newest entity through the guarantee.
    op({ opId: 's1c', entity: 'settlement', entityId: 's1', lamport: 7, actor: 'A', action: 'create', payload: { groupId: 'g1', fromMemberId: 'm2', toMemberId: 'm1', amountCents: 500, settledAt: '2026-07-14', createdAt: 7 } }),
    op({ opId: 's1d', entity: 'settlement', entityId: 's1', lamport: 8, actor: 'B', action: 'delete' }),
    op({ opId: 's2c', entity: 'settlement', entityId: 's2', lamport: 8, actor: 'B', action: 'create', payload: { groupId: 'g1', fromMemberId: 'm1', toMemberId: 'm2', amountCents: 300, settledAt: '2026-07-14', createdAt: 8 } }),
  ]

  it('produces identical state for 200 random permutations', () => {
    const canonical = foldOps(log)
    // Sanity: the canonical state has the expected shape across all entities.
    expect(canonical.expenses['e1'].amountCents).toBe(3500)
    expect(canonical.expenses['e2'].deleted).toBe(true)
    expect(canonical.settlements['s1'].deleted).toBe(true) // undone settlement
    expect(canonical.settlements['s2'].deleted).toBeFalsy() // kept settlement
    for (let i = 0; i < 200; i++) {
      expect(foldOps(shuffle(log, i + 1))).toEqual(canonical)
    }
  })

  it('two devices that each hold a subset converge once merged', () => {
    // Device A saw everything except Bob's edit; device B saw everything except the delete.
    const deviceA = log.filter((o) => o.opId !== 'e1u')
    const deviceB = log.filter((o) => o.opId !== 'e2d')
    const merged = foldOps([...deviceA, ...deviceB])
    expect(foldOps(log)).toEqual(merged)
    expect(merged.expenses['e1'].amountCents).toBe(3500) // Bob's edit survived
    expect(merged.expenses['e2'].deleted).toBe(true) // the delete survived
  })
})
