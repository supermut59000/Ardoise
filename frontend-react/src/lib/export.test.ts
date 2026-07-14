import { describe, it, expect } from 'vitest'
import { buildCsvExport, buildJsonExport } from './export'
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

  it('reflects an exact split in the repartition column', () => {
    const csv = buildCsvExport(
      members,
      [expense({ splitMode: 'exact', shares: [{ memberId: 'a', weight: 2000 }, { memberId: 'b', weight: 1000 }] })],
    )
    expect(csv).toContain('Alice: 20,00')
    expect(csv).toContain('Bob: 10,00')
  })
})
