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

/** Max ops per /sync request, so a long-offline device or a first share of a big
 *  group never exceeds the reverse proxy's body-size limit. */
export const PUSH_BATCH = 500

/** Push this group's unsynced ops in batches, marking each batch synced as it
 *  lands (a crash between batches only re-pushes, which the server dedups),
 *  and pull new ops in the SAME round trip (`POST /sync`). With nothing to
 *  push, one empty-batch call is a plain pull, so an idle sync is exactly one
 *  request. `reseed` marks a self-heal re-push of the whole log, which the
 *  server must not treat as live activity (no notification fan-out).
 *  Returns the pulled data of the LAST batch (ops dedup makes the earlier
 *  batches' pulls harmless). */
async function pushAndPull(
  groupId: string,
  database: ArdoiseDB,
  since: number,
  reseed = false,
): Promise<{ pushed: number; ops: client.WireOp[]; cursor: number; serverGeneration: string }> {
  const unsynced = (await database.operations.where('groupId').equals(groupId).toArray())
    .filter((o) => o.synced === 0)
    .sort((a, b) => a.lamport - b.lamport)
  const batches: client.WireOp[][] = []
  for (let i = 0; i < unsynced.length; i += PUSH_BATCH) {
    batches.push(unsynced.slice(i, i + PUSH_BATCH).map(toWire))
  }
  if (batches.length === 0) batches.push([])
  let last = { pushed: 0, ops: [] as client.WireOp[], cursor: since, serverGeneration: '' }
  for (const batch of batches) {
    const res = await client.syncOps(groupId, batch, since, reseed)
    if (batch.length > 0) {
      await database.operations
        .where('opId')
        .anyOf(batch.map((o) => o.opId))
        .modify({ synced: 1 })
    }
    last = { pushed: last.pushed + batch.length, ...res }
  }
  return last
}

/** Re-seed a group after the server lost (part of) its data: forget the cursor
 *  and mark every local op unsynced, so the next pass re-pushes the full log
 *  (idempotent server-side) and re-pulls everything the peers re-push. */
async function resetForReseed(
  groupId: string,
  database: ArdoiseDB,
  shareCode: string,
  serverGeneration: string,
): Promise<void> {
  await database.transaction('rw', database.operations, database.syncState, async () => {
    await database.operations.where('groupId').equals(groupId).modify({ synced: 0 })
    await database.syncState.put({ groupId, cursor: 0, shareCode, serverGeneration })
  })
}

/** True once a group-delete op for this group has reached the server (pushed
 *  here or pulled from a peer): the group is gone for everyone, and the device
 *  can stop tracking it. The syncState row must survive until then, or the
 *  delete op would never be pushed. */
async function groupDeleteSynced(database: ArdoiseDB, groupId: string): Promise<boolean> {
  const ops = await database.operations.where('groupId').equals(groupId).toArray()
  return ops.some(
    (o) => o.entity === 'group' && o.entityId === groupId && o.action === 'delete' && o.synced === 1,
  )
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
  reseed = false,
): Promise<SyncResult> {
  const state = await database.syncState.get(groupId)
  if (!state) return { pushed: 0, pulled: 0 }

  try {
    // Push unsynced local ops and pull new ops from peers in the same
    // round trip, then fold them in.
    const { pushed, ops, cursor, serverGeneration } = await pushAndPull(
      groupId,
      database,
      state.cursor,
      reseed,
    )

    // Sequence numbers restart after a DB wipe and can quickly overtake an old
    // cursor, so cursor comparison alone cannot identify a new database. A
    // generation mismatch always replays the full local log before ingesting.
    if (state.serverGeneration && serverGeneration !== state.serverGeneration && !healed) {
      await resetForReseed(groupId, database, state.shareCode, serverGeneration)
      return syncGroup(groupId, database, true, true)
    }

    if (ops.length > 0) {
      // Ops from the server are, by definition, already synced.
      const incoming: Operation[] = ops.map((w) => ({ ...w, synced: 1 }))
      await ingestOps(database, incoming)
    }

    if (cursor < state.cursor && !healed) {
      // Same database restored from an older backup: re-seed both directions.
      await resetForReseed(groupId, database, state.shareCode, serverGeneration)
      return syncGroup(groupId, database, true, true)
    }
    if (cursor !== state.cursor || state.serverGeneration !== serverGeneration) {
      await database.syncState.put({ ...state, cursor, serverGeneration })
    }
    // A group deleted (here or by a peer) stops being tracked once its tombstone
    // is on the server: an orphan row would re-register the dead group on every
    // future server wipe (B3). The row survives until then so the delete op is
    // still pushed on a later pass.
    if (await groupDeleteSynced(database, groupId)) {
      await database.syncState.delete(groupId)
    }
    return { pushed, pulled: ops.length }
  } catch (e) {
    if (!healed && e instanceof SyncError && e.status === 404) {
      // Server lost the group entirely: re-register (may mint a new share
      // code) and re-seed the full log from this device.
      const info = await client.registerGroup(groupId)
      await resetForReseed(groupId, database, info.shareCode, info.serverGeneration)
      return syncGroup(groupId, database, true, true)
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
    serverGeneration: info.serverGeneration,
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
    await database.syncState.put({
      groupId: info.groupId,
      cursor: 0,
      shareCode: info.shareCode,
      serverGeneration: info.serverGeneration,
    })
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
