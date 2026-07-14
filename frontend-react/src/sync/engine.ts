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

/** Max ops per push request, so a long-offline device or a first share of a big
 *  group never exceeds the reverse proxy's body-size limit. */
export const PUSH_BATCH = 500

/** Push this group's unsynced ops in batches, marking each batch synced as it
 *  lands (a crash between batches only re-pushes, which the server dedups). */
async function pushUnsynced(groupId: string, database: ArdoiseDB): Promise<number> {
  const unsynced = (await database.operations.where('groupId').equals(groupId).toArray())
    .filter((o) => o.synced === 0)
    .sort((a, b) => a.lamport - b.lamport)
  for (let i = 0; i < unsynced.length; i += PUSH_BATCH) {
    const batch = unsynced.slice(i, i + PUSH_BATCH)
    await client.pushOps(groupId, batch.map(toWire))
    await database.operations
      .where('opId')
      .anyOf(batch.map((o) => o.opId))
      .modify({ synced: 1 })
  }
  return unsynced.length
}

/** Re-seed a group after the server lost (part of) its data: forget the cursor
 *  and mark every local op unsynced, so the next pass re-pushes the full log
 *  (idempotent server-side) and re-pulls everything the peers re-push. */
async function resetForReseed(groupId: string, database: ArdoiseDB, shareCode: string): Promise<void> {
  await database.transaction('rw', database.operations, database.syncState, async () => {
    await database.operations.where('groupId').equals(groupId).modify({ synced: 0 })
    await database.syncState.put({ groupId, cursor: 0, shareCode })
  })
}

/**
 * Sync one group: push everything we have not yet pushed, then pull everything
 * new since our cursor and fold it in. Safe to call repeatedly and concurrently
 * with edits: pushes are idempotent (server dedups by opId) and pulls are
 * idempotent (ingestOps dedups + advances the clock). A group with no syncState
 * row (local-only, never shared) is skipped.
 *
 * Self-healing (the devices hold the full log; the server is disposable):
 *  - 404 (server lost the group, e.g. wiped DB): re-register the same group id
 *    and re-push the whole log. Every device heals itself the same way, so the
 *    server converges back to the union of everyone's history.
 *  - pull cursor BELOW ours (server restored from an older backup): reset the
 *    cursor and re-push/re-pull everything. Without this, peers' new ops land
 *    under our old cursor and are silently never pulled.
 * `healed` guards against looping if the server stays broken; the next sync
 * tick retries the whole sequence anyway.
 */
export async function syncGroup(
  groupId: string,
  database: ArdoiseDB = db,
  healed = false,
): Promise<SyncResult> {
  const state = await database.syncState.get(groupId)
  if (!state) return { pushed: 0, pulled: 0 }

  try {
    // 1) Push unsynced local ops (batched).
    const pushed = await pushUnsynced(groupId, database)

    // 2) Pull new ops from peers and fold them in.
    const { ops, cursor } = await client.pullOps(groupId, state.cursor)
    if (ops.length > 0) {
      // Ops from the server are, by definition, already synced.
      const incoming: Operation[] = ops.map((w) => ({ ...w, synced: 1 }))
      await ingestOps(database, incoming)
    }

    if (cursor < state.cursor && !healed) {
      // Server rewound (restore from an older backup): re-seed both directions.
      await resetForReseed(groupId, database, state.shareCode)
      return syncGroup(groupId, database, true)
    }
    if (cursor !== state.cursor) {
      await database.syncState.put({ ...state, cursor })
    }
    return { pushed, pulled: ops.length }
  } catch (e) {
    if (!healed && e instanceof SyncError && e.status === 404) {
      // Server lost the group entirely: re-register (may mint a new share
      // code) and re-seed the full log from this device.
      const info = await client.registerGroup(groupId)
      await resetForReseed(groupId, database, info.shareCode)
      return syncGroup(groupId, database, true)
    }
    throw e
  }
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

/** How many of this group's local ops have not reached the server yet. Used by
 *  the leave dialog to warn before discarding them. */
export async function countUnsyncedFor(groupId: string, database: ArdoiseDB = db): Promise<number> {
  const ops = await database.operations.where('groupId').equals(groupId).toArray()
  return ops.filter((o) => o.synced === 0).length
}

/**
 * Leave a shared group on THIS device only: drop its local ops and sync state.
 * The server and the other participants keep everything; re-joining with the
 * share code restores the group in full. Never call this on a local-only group
 * (its ops exist nowhere else); the UI only offers it for shared groups.
 */
export async function leaveGroup(groupId: string, database: ArdoiseDB = db): Promise<void> {
  await database.transaction('rw', database.operations, database.syncState, async () => {
    await database.operations.where('groupId').equals(groupId).delete()
    await database.syncState.delete(groupId)
  })
}
