import type { AppState, Expense, Group, Member, Settlement } from '@/domain/types'
import { compareOps, type Operation } from './operation'

/**
 * Fold an operation log into current state. This is the heart of the app and the
 * reason multi-device sync is safe:
 *
 *  - PURE and DETERMINISTIC: state depends only on the SET of operations, not the
 *    order they arrived in. We sort by (lamport, opId) before reducing, so any
 *    permutation of the same operations yields byte-identical state.
 *  - IDEMPOTENT: duplicate opIds are collapsed, so replaying / re-pushing an
 *    operation is a no-op.
 *  - LAST-WRITER-WINS per field: later operations (in total order) overwrite the
 *    fields they carry; fields they omit are left untouched.
 *  - DELETE IS TERMINAL: once an entity is deleted it stays deleted, so a delete
 *    always beats a concurrent (or even later) edit. Matches user intent.
 */
export function foldOps(ops: Operation[]): AppState {
  const state: AppState = { groups: {}, members: {}, expenses: {}, settlements: {} }

  // Idempotency: keep one operation per opId.
  const unique = new Map<string, Operation>()
  for (const op of ops) if (!unique.has(op.opId)) unique.set(op.opId, op)

  const ordered = [...unique.values()].sort(compareOps)
  for (const op of ordered) reduceOp(state, op)
  return state
}

function reduceOp(state: AppState, op: Operation): void {
  // An update/delete whose create has not been folded yet (orphan) leaves the
  // entity absent rather than writing an `undefined` into the map.
  switch (op.entity) {
    case 'group': {
      const next = applyTo(state.groups[op.entityId], op)
      if (next) state.groups[op.entityId] = next as Group
      break
    }
    case 'member': {
      const next = applyTo(state.members[op.entityId], op)
      if (next) state.members[op.entityId] = next as Member
      break
    }
    case 'expense': {
      const next = applyTo(state.expenses[op.entityId], op)
      if (next) state.expenses[op.entityId] = next as Expense
      break
    }
    case 'settlement': {
      const next = applyTo(state.settlements[op.entityId], op)
      if (next) state.settlements[op.entityId] = next as Settlement
      break
    }
  }
}

/**
 * Apply one operation to one entity. Returns the new entity (or the unchanged
 * one). Never returns undefined once an entity exists, so tombstones persist.
 */
function applyTo<T extends { id: string; deleted?: boolean }>(
  current: T | undefined,
  op: Operation,
): T | undefined {
  switch (op.action) {
    case 'create':
      // Create, or merge onto an existing entity. A create can never resurrect a
      // tombstone: `current.deleted` survives because payload does not clear it.
      return { ...(current ?? {}), ...op.payload, id: op.entityId } as T
    case 'update':
      // LWW field merge, but only on a live entity: updates to a missing or
      // deleted entity are dropped.
      if (!current || current.deleted) return current
      return { ...current, ...op.payload, id: op.entityId } as T
    case 'delete':
      if (!current) return current
      return { ...current, deleted: true } as T
    default:
      return current
  }
}

// Convenience selectors over folded state (skip tombstones).

export function activeMembers(state: AppState, groupId: string): Member[] {
  return Object.values(state.members)
    .filter((m) => m.groupId === groupId && !m.deleted)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function activeExpenses(state: AppState, groupId: string): Expense[] {
  return Object.values(state.expenses)
    .filter((e) => e.groupId === groupId && !e.deleted)
    .sort((a, b) => b.spentAt.localeCompare(a.spentAt) || b.createdAt - a.createdAt)
}

export function activeGroups(state: AppState): Group[] {
  return Object.values(state.groups)
    .filter((g) => !g.deleted)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function activeSettlements(state: AppState, groupId: string): Settlement[] {
  return Object.values(state.settlements)
    .filter((s) => s.groupId === groupId && !s.deleted)
    .sort((a, b) => b.settledAt.localeCompare(a.settledAt) || b.createdAt - a.createdAt)
}
