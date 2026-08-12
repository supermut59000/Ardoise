import Dexie, { type Table } from 'dexie'
import type { Operation } from '@/sync/operation'
import { newId } from '@/sync/operation'

interface MetaRow {
  key: string
  deviceId: string
  lamport: number
}

/** Per-group sync bookkeeping. A row exists only for groups that have been
 *  shared (registered) or joined; local-only groups never sync. */
export interface SyncState {
  groupId: string
  cursor: number // highest server seq we have pulled
  shareCode: string
  /** Identifies the server DB lifetime; a changed value means the DB was wiped. */
  serverGeneration?: string
}

/**
 * Local-first store. The `operations` table is the single source of truth; all
 * app state is folded from it. `meta` holds this device's id and lamport clock.
 */
export class ArdoiseDB extends Dexie {
  operations!: Table<Operation, string>
  meta!: Table<MetaRow, string>
  syncState!: Table<SyncState, string>

  constructor(name = 'ardoise') {
    super(name)
    this.version(1).stores({
      // opId is the PK; the rest are indexes used by fold/pull queries.
      operations: 'opId, groupId, [groupId+lamport], lamport, synced',
      meta: 'key',
    })
    // v2: per-group sync cursor + share code (Phase 2). Existing stores carry over.
    this.version(2).stores({
      syncState: 'groupId',
    })
  }
}

export const db = new ArdoiseDB()

const META_KEY = 'app'

/** Read (creating on first use) this device's meta row. */
export async function getMeta(database: ArdoiseDB = db): Promise<MetaRow> {
  const existing = await database.meta.get(META_KEY)
  if (existing) return existing
  const fresh: MetaRow = { key: META_KEY, deviceId: newId(), lamport: 0 }
  await database.meta.put(fresh)
  return fresh
}

/**
 * Bump and return the next lamport value inside a caller-provided transaction.
 * Must run within an rw transaction that includes the `meta` table so the
 * read-modify-write is atomic (no two operations can grab the same tick).
 */
export async function bumpLamport(database: ArdoiseDB, incomingMax = 0): Promise<{ lamport: number; deviceId: string }> {
  const meta = (await database.meta.get(META_KEY)) ?? {
    key: META_KEY,
    deviceId: newId(),
    lamport: 0,
  }
  // Lamport rule: strictly greater than anything seen locally or from peers.
  meta.lamport = Math.max(meta.lamport, incomingMax) + 1
  await database.meta.put(meta)
  return { lamport: meta.lamport, deviceId: meta.deviceId }
}

/**
 * Ingest operations received from a peer / the server (Phase 2 sync, and the
 * merge path exercised by tests). Two things must happen atomically:
 *   1. store the ops idempotently (bulkPut keyed by opId, so re-pulling is safe);
 *   2. advance this device's lamport clock past everything ingested, so the next
 *      locally-authored op sorts strictly AFTER what we just saw. Skipping step 2
 *      lets a fresh local op collide with older ops and land out of order.
 */
export async function ingestOps(database: ArdoiseDB, incoming: Operation[]): Promise<void> {
  if (incoming.length === 0) return
  await database.transaction('rw', database.meta, database.operations, async () => {
    const maxIncoming = incoming.reduce((m, o) => Math.max(m, o.lamport), 0)
    const meta = (await database.meta.get(META_KEY)) ?? {
      key: META_KEY,
      deviceId: newId(),
      lamport: 0,
    }
    meta.lamport = Math.max(meta.lamport, maxIncoming)
    await database.meta.put(meta)
    await database.operations.bulkPut(incoming)
  })
}
