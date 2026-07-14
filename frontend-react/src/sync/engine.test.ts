import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ArdoiseDB } from '@/db/dexie'
import { foldOps } from './fold'
import { addExpense, addMember, addSettlement, createGroup } from './ops'
import { activeSettlements } from './fold'
import { joinGroup, shareGroup, syncAllGroups, syncGroup } from './engine'
import type { WireOp } from './client'

/**
 * In-memory stand-in for the FastAPI backend, shared by all "devices" in a test.
 * Mirrors the real endpoints: register (idempotent), resolve, push (dedup +
 * seq), pull (seq > since). `offline` makes every request throw like a dropped
 * network.
 */
function installMockServer() {
  const groups = new Map<string, { shareCode: string }>()
  const codes = new Map<string, string>() // shareCode -> groupId
  const ops: (WireOp & { seq: number })[] = []
  let seq = 0
  const server = { offline: false, ops, requests: 0 }

  function json(data: unknown, status = 200) {
    return { ok: status < 400, status, json: async () => data } as Response
  }

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    server.requests++
    if (server.offline) throw new TypeError('Failed to fetch')

    const url = new URL(String(input), 'http://test')
    const path = url.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined

    let m: RegExpMatchArray | null

    if (path === '/api/v1/groups/register' && method === 'POST') {
      const gid = body.groupId
      if (!groups.has(gid)) {
        const shareCode = `CODE${groups.size + 1}`
        groups.set(gid, { shareCode })
        codes.set(shareCode, gid)
      }
      return json({ groupId: gid, shareCode: groups.get(gid)!.shareCode })
    }

    if ((m = path.match(/^\/api\/v1\/groups\/resolve\/(.+)$/)) && method === 'GET') {
      const gid = codes.get(m[1])
      if (!gid) return json({ detail: 'not found' }, 404)
      return json({ groupId: gid, shareCode: m[1] })
    }

    if ((m = path.match(/^\/api\/v1\/groups\/([^/]+)\/ops$/)) && method === 'POST') {
      const gid = m[1]
      if (!groups.has(gid)) return json({ detail: 'not registered' }, 404)
      let accepted = 0
      for (const o of body.ops as WireOp[]) {
        if (ops.some((e) => e.opId === o.opId)) continue
        ops.push({ ...o, seq: ++seq })
        accepted++
      }
      const cursor = ops.filter((o) => o.groupId === gid).reduce((mx, o) => Math.max(mx, o.seq), 0)
      return json({ accepted, cursor })
    }

    if ((m = path.match(/^\/api\/v1\/groups\/([^/]+)\/ops$/)) && method === 'GET') {
      const gid = m[1]
      if (!groups.has(gid)) return json({ detail: 'not registered' }, 404)
      const since = Number(url.searchParams.get('since') ?? '0')
      const rows = ops
        .filter((o) => o.groupId === gid && o.seq > since)
        .sort((a, b) => a.seq - b.seq)
      const cursor = rows.length ? rows[rows.length - 1].seq : since
      // strip seq from the wire payload, like the real server
      return json({ ops: rows.map(({ seq: _seq, ...w }) => w), cursor })
    }

    return json({ detail: 'unhandled' }, 404)
  }) as typeof fetch

  return server
}

let server: ReturnType<typeof installMockServer>
let n = 0
const freshDb = async () => {
  const d = new ArdoiseDB(`engine-${n++}`)
  await d.open()
  return d
}

beforeEach(() => {
  server = installMockServer()
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function seedGroup(dbx: ArdoiseDB) {
  const g = await createGroup({ name: 'Trip' }, dbx)
  const a = await addMember(g, 'Alice', dbx)
  const b = await addMember(g, 'Bob', dbx)
  await addExpense(
    g,
    { description: 'Hotel', amountCents: 10000, paidBy: a, spentAt: '2026-07-13', shares: [a, b].map((m) => ({ memberId: m, weight: 1 })) },
    dbx,
  )
  return g
}

describe('shareGroup', () => {
  it('registers, pushes all ops, and marks them synced', async () => {
    const db1 = await freshDb()
    const g = await seedGroup(db1)
    const code = await shareGroup(g, db1)

    expect(code).toMatch(/^CODE/)
    // every local op is now marked synced
    const unsynced = (await db1.operations.toArray()).filter((o) => o.synced === 0)
    expect(unsynced).toHaveLength(0)
    // the server received them
    expect(server.ops.filter((o) => o.groupId === g).length).toBe(4)
  })
})

describe('two devices over the wire', () => {
  it('a second device joins by code and converges', async () => {
    const db1 = await freshDb()
    const g = await seedGroup(db1)
    const code = await shareGroup(g, db1)

    const db2 = await freshDb()
    const joinedId = await joinGroup(code, db2)
    expect(joinedId).toBe(g)

    const s1 = foldOps(await db1.operations.toArray())
    const s2 = foldOps(await db2.operations.toArray())
    expect(s2).toEqual(s1)
  })

  it('edits round-trip both directions', async () => {
    const db1 = await freshDb()
    const g = await seedGroup(db1)
    const code = await shareGroup(g, db1)
    const db2 = await freshDb()
    await joinGroup(code, db2)

    // db2 adds an expense, pushes
    const members2 = Object.values(foldOps(await db2.operations.toArray()).members)
    await addExpense(
      g,
      { description: 'Diner', amountCents: 4000, paidBy: members2[0].id, spentAt: '2026-07-14', shares: members2.map((m) => ({ memberId: m.id, weight: 1 })) },
      db2,
    )
    await syncGroup(g, db2)

    // db1 pulls it
    await syncGroup(g, db1)

    const s1 = foldOps(await db1.operations.toArray())
    const s2 = foldOps(await db2.operations.toArray())
    expect(s1).toEqual(s2)
    expect(Object.values(s1.expenses).some((e) => e.description === 'Diner')).toBe(true)
  })
})

describe('settlements sync like any other op', () => {
  it('a settlement recorded on one device reaches the other', async () => {
    const db1 = await freshDb()
    const g = await seedGroup(db1)
    const code = await shareGroup(g, db1)
    const db2 = await freshDb()
    await joinGroup(code, db2)

    // db1 records that Bob paid Alice back; push it.
    const members = Object.values(foldOps(await db1.operations.toArray()).members)
    await addSettlement(
      g,
      { fromMemberId: members[1].id, toMemberId: members[0].id, amountCents: 2500, settledAt: '2026-07-14' },
      db1,
    )
    await syncGroup(g, db1)

    // db2 pulls and sees the settlement.
    await syncGroup(g, db2)
    const settlements2 = activeSettlements(foldOps(await db2.operations.toArray()), g)
    expect(settlements2).toHaveLength(1)
    expect(settlements2[0].amountCents).toBe(2500)
  })
})

describe('offline resilience', () => {
  it('keeps unsynced ops when offline and pushes them on reconnect', async () => {
    const db1 = await freshDb()
    const g = await seedGroup(db1)
    await shareGroup(g, db1) // online: everything pushed

    // Go offline, add an expense locally.
    server.offline = true
    const members = Object.values(foldOps(await db1.operations.toArray()).members)
    await addExpense(
      g,
      { description: 'Cafe', amountCents: 300, paidBy: members[0].id, spentAt: '2026-07-15', shares: [{ memberId: members[0].id, weight: 1 }] },
      db1,
    )
    // syncAllGroups must not throw while offline.
    await expect(syncAllGroups(db1)).resolves.toBeUndefined()
    expect((await db1.operations.toArray()).filter((o) => o.synced === 0)).toHaveLength(1)

    // Reconnect: the queued op gets pushed.
    server.offline = false
    await syncAllGroups(db1)
    expect((await db1.operations.toArray()).filter((o) => o.synced === 0)).toHaveLength(0)
    expect(server.ops.some((o) => o.payload.description === 'Cafe')).toBe(true)
  })

  it('local-only (never shared) groups are not synced', async () => {
    const db1 = await freshDb()
    await seedGroup(db1) // never shared
    await syncAllGroups(db1)
    expect(server.ops).toHaveLength(0)
  })
})

describe('idempotent repeated sync', () => {
  it('syncing twice adds no duplicate ops and is stable', async () => {
    const db1 = await freshDb()
    const g = await seedGroup(db1)
    const code = await shareGroup(g, db1)
    const db2 = await freshDb()
    await joinGroup(code, db2)

    const before = (await db2.operations.toArray()).length
    await syncGroup(g, db2)
    await syncGroup(g, db2)
    const after = (await db2.operations.toArray()).length
    expect(after).toBe(before)
    // server op count also stable (no duplicate pushes)
    expect(server.ops.filter((o) => o.groupId === g).length).toBe(4)
  })
})
