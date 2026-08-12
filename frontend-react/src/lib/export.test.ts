import { describe, it, expect } from 'vitest'
import { buildCsvExport, buildJsonExport, importJsonExport, parseJsonExport } from './export'
import { ArdoiseDB } from '@/db/dexie'
import type { Expense, Member } from '@/domain/types'
import type { Operation } from '@/sync/operation'

const members: Member[] = [
  { id: 'a', groupId: 'g', name: 'Alice', createdAt: 1 },
  { id: 'b', groupId: 'g', name: 'Bob', createdAt: 2 },
]
const expense = (over: Partial<Expense> = {}): Expense => ({
  id: 'e1',
  groupId: 'g',
  description: 'Courses',
  amountCents: 3000,
  paidBy: 'a',
  spentAt: '2026-07-13',
  splitMode: 'equal',
  shares: [{ memberId: 'a', weight: 1 }, { memberId: 'b', weight: 1 }],
  createdAt: 1,
  ...over,
})

describe('buildJsonExport', () => {
  it('wraps the op log with metadata and is valid JSON', () => {
    const ops = [{ opId: 'o1' } as unknown as Operation]
    const parsed = JSON.parse(buildJsonExport('Trip', ops))
    expect(parsed.app).toBe('ardoise')
    expect(parsed.group).toBe('Trip')
    expect(parsed.operationCount).toBe(1)
    expect(parsed.operations).toHaveLength(1)
  })
})

const wireOp = (opId: string, over: Partial<Operation> = {}): Operation => ({
  opId,
  groupId: 'g',
  entity: 'expense',
  entityId: `ent-${opId}`,
  action: 'create',
  payload: { amountCents: 100 },
  actor: 'devA',
  lamport: 1,
  createdAt: 1_700_000_000_000,
  synced: 1, // exports carry the device's flag; import must ignore it
  ...over,
})

describe('parseJsonExport', () => {
  it('round-trips a build and marks every op unsynced (re-pushable)', () => {
    const text = buildJsonExport('Trip', [wireOp('o1'), wireOp('o2')])
    const { ops, invalid } = parseJsonExport(text)
    expect(ops.map((o) => o.opId)).toEqual(['o1', 'o2'])
    expect(ops.every((o) => o.synced === 0)).toBe(true)
    expect(invalid).toBe(0)
  })

  it('rejects a file that is not an Ardoise export, in French', () => {
    expect(() => parseJsonExport('pas du json')).toThrow(/export Ardoise/)
    expect(() => parseJsonExport('{"app":"autre","operations":[]}')).toThrow(/export Ardoise/)
    expect(() => parseJsonExport('{"app":"ardoise"}')).toThrow(/export Ardoise/)
  })

  it('skips malformed entries and counts them', () => {
    const text = JSON.stringify({
      app: 'ardoise',
      operations: [wireOp('ok'), { opId: 'bad' }, 42, wireOp('ok2', { entity: 'invalid' as never })],
    })
    const { ops, invalid } = parseJsonExport(text)
    expect(ops.map((o) => o.opId)).toEqual(['ok'])
    expect(invalid).toBe(3)
  })

  it('extracts valid shared refs and drops malformed ones', () => {
    const text = JSON.stringify({
      app: 'ardoise',
      operations: [],
      shared: [{ groupId: 'g', shareCode: 'ABCD2345' }, { groupId: '' }, 'junk', { groupId: 'x' }],
    })
    expect(parseJsonExport(text).shared).toEqual([{ groupId: 'g', shareCode: 'ABCD2345' }])
  })
})

describe('importJsonExport', () => {
  it('replays an export into a device and is idempotent on re-import', async () => {
    const d = new ArdoiseDB('export-import-test')
    await d.open()
    const text = buildJsonExport('Trip', [wireOp('i1'), wireOp('i2')])

    const first = await importJsonExport(text, d)
    expect(first).toEqual({ imported: 2, existing: 0, invalid: 0, relinked: 0 })
    // stored unsynced so a shared group re-pushes them (server dedups by opId)
    expect((await d.operations.toArray()).every((o) => o.synced === 0)).toBe(true)

    const second = await importJsonExport(text, d)
    expect(second).toEqual({ imported: 0, existing: 2, invalid: 0, relinked: 0 })
    expect(await d.operations.count()).toBe(2)
  })

  it('restores sync for groups the export marks as shared (fresh-device restore)', async () => {
    // The regression this guards: importing a backup on a new phone used to
    // leave a previously-shared group silently local-only (no syncState row),
    // so it never synced again until the user re-shared by hand.
    const d = new ArdoiseDB('export-relink-test')
    await d.open()
    const text = buildJsonExport('Trip', [wireOp('r1')], [{ groupId: 'g', shareCode: 'ABCD2345' }])

    const result = await importJsonExport(text, d)
    expect(result.relinked).toBe(1)
    expect(await d.syncState.get('g')).toEqual({ groupId: 'g', cursor: 0, shareCode: 'ABCD2345' })

    // Idempotent: a second import never touches the existing row.
    await d.syncState.put({ groupId: 'g', cursor: 42, shareCode: 'ABCD2345' })
    const again = await importJsonExport(text, d)
    expect(again.relinked).toBe(0)
    expect((await d.syncState.get('g'))?.cursor).toBe(42)
  })

  it('accepts a v1 export without the shared field (no relink, ops import)', async () => {
    const d = new ArdoiseDB('export-v1-test')
    await d.open()
    const v1 = JSON.stringify({ app: 'ardoise', version: 1, operations: [wireOp('v1op')] })
    const result = await importJsonExport(v1, d)
    expect(result).toEqual({ imported: 1, existing: 0, invalid: 0, relinked: 0 })
    expect(await d.syncState.count()).toBe(0)
  })
})

describe('buildCsvExport', () => {
  it('emits a header and one row per expense, comma decimals', () => {
    const csv = buildCsvExport(members, [expense()])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Date;Description;Montant;Paye par;Repartition')
    expect(lines[1]).toContain('2026-07-13;Courses;30,00;Alice;')
    expect(lines[1]).toContain('Alice: 15,00')
    expect(lines[1]).toContain('Bob: 15,00')
  })

  it('quotes fields containing the delimiter', () => {
    const csv = buildCsvExport(members, [expense({ description: 'Diner; pourboire' })])
    expect(csv).toContain('"Diner; pourboire"')
  })

  it('neutralizes spreadsheet formulas in text fields', () => {
    const csv = buildCsvExport(members, [expense({ description: '=1+1' })])
    expect(csv).toContain(";'=1+1;")
    expect(csv).not.toContain(';=1+1;')
  })

  it('reflects an exact split in the repartition column', () => {
    const csv = buildCsvExport(
      members,
      [expense({ splitMode: 'exact', shares: [{ memberId: 'a', weight: 2000 }, { memberId: 'b', weight: 1000 }] })],
    )
    expect(csv).toContain('Alice: 20,00')
    expect(csv).toContain('Bob: 10,00')
  })

  it('names a removed-but-referenced member like the UI, never "?"', () => {
    // Concurrent-edit scenario: Bob was deleted on another device while this
    // one added an expense he paid. The UI shows "Ancien participant" (D22);
    // the CSV twin had kept the old "?".
    const onlyAlice = members.filter((m) => m.id === 'a')
    const csv = buildCsvExport(onlyAlice, [expense({ paidBy: 'b' })])
    expect(csv).toContain('Ancien participant')
    expect(csv).not.toContain('?')
  })
})
