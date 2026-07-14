import { db, ingestOps, type ArdoiseDB } from '@/db/dexie'
import { activeExpenses, activeMembers, foldOps } from '@/sync/fold'
import { computeOwed } from '@/domain/split'
import { emitLocalChange } from '@/sync/events'
import type { Expense, Member } from '@/domain/types'
import type { Operation } from '@/sync/operation'
import { todayIso } from './format'

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

const ENTITIES = new Set(['group', 'member', 'expense', 'settlement'])
const ACTIONS = new Set(['create', 'update', 'delete'])

function isValidOp(o: unknown): o is Operation {
  if (typeof o !== 'object' || o === null) return false
  const r = o as Record<string, unknown>
  return (
    typeof r.opId === 'string' && r.opId.length > 0 &&
    typeof r.groupId === 'string' && r.groupId.length > 0 &&
    typeof r.entityId === 'string' && r.entityId.length > 0 &&
    ENTITIES.has(r.entity as string) &&
    ACTIONS.has(r.action as string) &&
    typeof r.payload === 'object' && r.payload !== null &&
    typeof r.actor === 'string' &&
    typeof r.lamport === 'number' && Number.isFinite(r.lamport) &&
    typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
  )
}

/**
 * Parse an Ardoise JSON export back into operations (the "re-import by replay"
 * side of own-your-data). Throws a French message if the file is not an Ardoise
 * export; silently skips individual malformed ops (returned separately so the
 * UI can report the count). Imported ops are marked unsynced so a shared group
 * re-pushes them (the server dedups by opId, so re-importing is always safe).
 */
export function parseJsonExport(text: string): { ops: Operation[]; invalid: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Ce fichier n'est pas un export Ardoise valide")
  }
  const envelope = parsed as { app?: unknown; operations?: unknown }
  if (envelope?.app !== 'ardoise' || !Array.isArray(envelope.operations)) {
    throw new Error("Ce fichier n'est pas un export Ardoise valide")
  }
  const ops: Operation[] = []
  let invalid = 0
  for (const raw of envelope.operations) {
    if (isValidOp(raw)) ops.push({ ...raw, synced: 0 })
    else invalid++
  }
  return { ops, invalid }
}

export interface ImportResult {
  imported: number // new ops folded in
  existing: number // ops already on this device (untouched)
  invalid: number // malformed entries skipped
}

/**
 * Replay an export file into the local log. Idempotent: ops already present are
 * left untouched (their synced flag included). New ops arrive unsynced, so the
 * sync engine re-pushes them to the server for any shared group.
 */
export async function importJsonExport(text: string, database: ArdoiseDB = db): Promise<ImportResult> {
  const { ops, invalid } = parseJsonExport(text)
  const ids = ops.map((o) => o.opId)
  const existingIds = new Set(
    (await database.operations.where('opId').anyOf(ids).primaryKeys()) as string[],
  )
  const fresh = ops.filter((o) => !existingIds.has(o.opId))
  if (fresh.length > 0) {
    await ingestOps(database, fresh)
    emitLocalChange() // let the sync engine push them promptly
  }
  return { imported: fresh.length, existing: existingIds.size, invalid }
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
const today = () => todayIso()

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
