import { db, ingestOps, type ArdoiseDB } from '@/db/dexie'
import * as client from './client'
import { SyncError, toWire } from './client'
import type { Operation } from './operation'

export interface SyncResult {
  pushed: number
  pulled: number
}

/** Outcome of a full sync pass, so the UI can react (prompt for password, etc.). */
export interface SyncSummary {
  authError: boolean // at least one group was rejected for a bad/missing password
  networkError: boolean // at least one group failed for a transient reason
}

/**
 * Sync one group: push everything we have not yet pushed, then pull everything
 * new since our cursor and fold it in. Safe to call repeatedly and concurrently
 * with edits: pushes are idempotent (server dedups by opId) and pulls are
 * idempotent (ingestOps dedups + advances the clock). A group with no syncState
 * row (local-only, never shared) is skipped.
 */
export async function syncGroup(groupId: string, database: ArdoiseDB = db): Promise<SyncResult> {
  const state = await database.syncState.get(groupId)
  if (!state) return { pushed: 0, pulled: 0 }

  // 1) Push unsynced local ops.
  const unsynced = (await database.operations.where('groupId').equals(groupId).toArray()).filter(
    (o) => o.synced === 0,
  )
  let pushed = 0
  if (unsynced.length > 0) {
    await client.pushOps(groupId, unsynced.map(toWire))
    await database.operations
      .where('opId')
      .anyOf(unsynced.map((o) => o.opId))
      .modify({ synced: 1 })
    pushed = unsynced.length
  }

  // 2) Pull new ops from peers and fold them in.
  const { ops, cursor } = await client.pullOps(groupId, state.cursor)
  if (ops.length > 0) {
    // Ops from the server are, by definition, already synced.
    const incoming: Operation[] = ops.map((w) => ({ ...w, synced: 1 }))
    await ingestOps(database, incoming)
  }
  if (cursor !== state.cursor) {
    await database.syncState.put({ ...state, cursor })
  }

  return { pushed, pulled: ops.length }
}

/** Sync every registered/joined group. Errors are classified (not shown to the
 *  user) so the caller can react: a 401 means the password is wrong/missing. One
 *  group's failure never blocks the others; the next tick retries. */
export async function syncAllGroups(database: ArdoiseDB = db): Promise<SyncSummary> {
  const states = await database.syncState.toArray()
  let authError = false
  let networkError = false
  for (const s of states) {
    try {
      await syncGroup(s.groupId, database)
    } catch (e) {
      if (e instanceof SyncError && e.status === 401) authError = true
      else networkError = true
    }
  }
  return { authError, networkError }
}

/** How many local ops in shared groups have not reached the server yet. Drives
 *  the "changes pending" indicator so nothing silently fails to sync. */
export async function countUnsyncedShared(database: ArdoiseDB = db): Promise<number> {
  const states = await database.syncState.toArray()
  if (states.length === 0) return 0
  const shared = new Set(states.map((s) => s.groupId))
  const unsynced = await database.operations.where('synced').equals(0).toArray()
  return unsynced.filter((o) => shared.has(o.groupId)).length
}

/** Register a local group on the server, store its share code, and push it. */
export async function shareGroup(groupId: string, database: ArdoiseDB = db): Promise<string> {
  const info = await client.registerGroup(groupId)
  const existing = await database.syncState.get(groupId)
  await database.syncState.put({
    groupId,
    cursor: existing?.cursor ?? 0,
    shareCode: info.shareCode,
  })
  await syncGroup(groupId, database)
  return info.shareCode
}

/** Join a group by share code: resolve it, register the cursor, and pull its ops.
 *  Returns the joined group id. */
export async function joinGroup(shareCode: string, database: ArdoiseDB = db): Promise<string> {
  const info = await client.resolveCode(shareCode.trim().toUpperCase())
  const existing = await database.syncState.get(info.groupId)
  if (!existing) {
    await database.syncState.put({ groupId: info.groupId, cursor: 0, shareCode: info.shareCode })
  }
  await syncGroup(info.groupId, database)
  return info.groupId
}

/** Is this group shared/synced? Used by the UI to show the right share affordance. */
export async function isShared(groupId: string, database: ArdoiseDB = db): Promise<boolean> {
  return (await database.syncState.get(groupId)) !== undefined
}
