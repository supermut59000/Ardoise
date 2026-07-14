export type Entity = 'group' | 'member' | 'expense' | 'settlement'
export type Action = 'create' | 'update' | 'delete'

/**
 * One immutable change. The client generates these locally and (in Phase 2)
 * ships them to the server. State is derived purely by folding operations, so an
 * operation is never mutated after creation.
 */
export interface Operation {
  opId: string // client-generated UUID, globally unique -> idempotent
  groupId: string
  entity: Entity
  entityId: string
  action: Action
  payload: Record<string, unknown>
  actor: string // device id that authored it
  lamport: number // logical clock for deterministic ordering
  createdAt: number // wall clock (tiebreak + display)
  synced: 0 | 1 // 0 = not yet pushed to server (Phase 2). Indexed in Dexie.
}

export function newId(): string {
  // crypto.randomUUID exists in browsers and modern Node.
  return crypto.randomUUID()
}

/**
 * Total order over operations: lamport first, then opId as a stable tiebreak.
 * Two devices holding the same set of operations sort them identically, which
 * is what makes the fold converge no matter the arrival order.
 */
export function compareOps(a: Operation, b: Operation): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0
}
