import { db } from '@/db/dexie'
import { activeExpenses, activeMembers, foldOps } from '@/sync/fold'
import { computeOwed } from '@/domain/split'
import type { Expense, Member } from '@/domain/types'
import type { Operation } from '@/sync/operation'

// ---- Pure builders (unit-tested) ----

/** Full JSON export: the raw operation log is the real 'own your data' artifact. */
export function buildJsonExport(groupName: string, ops: Operation[]): string {
  return JSON.stringify(
    {
      app: 'ardoise',
      version: 1,
      group: groupName,
      exportedAt: new Date().toISOString(),
      operationCount: ops.length,
      operations: ops,
    },
    null,
    2,
  )
}

function csvField(value: string): string {
  // Quote if it contains the delimiter, a quote, or a newline (RFC 4180-ish).
  if (/[";\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

const amount = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')

/**
 * Human-readable CSV of a group's expenses. Semicolon-delimited and comma
 * decimals so French Excel opens it cleanly. One row per expense; the
 * "Repartition" column lists each participant's owed share.
 */
export function buildCsvExport(members: Member[], expenses: Expense[]): string {
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? '?'
  const header = ['Date', 'Description', 'Montant', 'Paye par', 'Repartition']

  const rows = expenses.map((e) => {
    const owed = computeOwed(e.amountCents, e.splitMode, e.shares)
    const repartition = [...owed.entries()]
      .map(([memberId, cents]) => `${name(memberId)}: ${amount(cents)}`)
      .join(', ')
    return [e.spentAt, e.description, amount(e.amountCents), name(e.paidBy), repartition]
  })

  return [header, ...rows].map((r) => r.map(csvField).join(';')).join('\n')
}

// ---- Download wrappers (browser only) ----

function download(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'groupe'
const today = () => new Date().toISOString().slice(0, 10)

export async function exportGroupJson(groupId: string): Promise<void> {
  const ops = await db.operations.where('groupId').equals(groupId).toArray()
  const state = foldOps(ops)
  const groupName = state.groups[groupId]?.name ?? 'groupe'
  download(`ardoise-${slug(groupName)}-${today()}.json`, 'application/json', buildJsonExport(groupName, ops))
}

export async function exportAllJson(): Promise<void> {
  const ops = await db.operations.toArray()
  download(`ardoise-tout-${today()}.json`, 'application/json', buildJsonExport('tout', ops))
}

export async function exportGroupCsv(groupId: string): Promise<void> {
  const ops = await db.operations.where('groupId').equals(groupId).toArray()
  const state = foldOps(ops)
  const groupName = state.groups[groupId]?.name ?? 'groupe'
  const csv = buildCsvExport(activeMembers(state, groupId), activeExpenses(state, groupId))
  // BOM so Excel detects UTF-8 accents.
  download(`ardoise-${slug(groupName)}-${today()}.csv`, 'text/csv;charset=utf-8', '﻿' + csv)
}
