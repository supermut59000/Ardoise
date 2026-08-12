import { db, ingestOps, type ArdoiseDB } from '@/db/dexie'
import { activeExpenses, activeMembers, foldOps } from '@/sync/fold'
import { computeOwed } from '@/domain/split'
import { emitLocalChange } from '@/sync/events'
import type { Expense, Member } from '@/domain/types'
import type { Operation } from '@/sync/operation'
import { todayIso } from './format'

// ---- Pure builders (unit-tested) ----

/** Which groups were shared, so a restore on a fresh device can re-link sync
 *  instead of silently importing them as local-only. */
export interface SharedRef {
  groupId: string
  shareCode: string
}

/** Full JSON export: the raw operation log is the real 'own your data' artifact.
 *  v2 adds `shared` (the share codes of synced groups); v1 files import fine. */
export function buildJsonExport(groupName: string, ops: Operation[], shared: SharedRef[] = []): string {
  return JSON.stringify(
    {
      app: 'ardoise',
      version: 2,
      group: groupName,
      exportedAt: new Date().toISOString(),
      operationCount: ops.length,
      shared,
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
export function parseJsonExport(text: string): { ops: Operation[]; invalid: number; shared: SharedRef[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Ce fichier n'est pas un export Ardoise valide")
  }
  const envelope = parsed as { app?: unknown; operations?: unknown; shared?: unknown }
  if (envelope?.app !== 'ardoise' || !Array.isArray(envelope.operations)) {
    throw new Error("Ce fichier n'est pas un export Ardoise valide")
  }
  const ops: Operation[] = []
  let invalid = 0
  for (const raw of envelope.operations) {
    if (isValidOp(raw)) ops.push({ ...raw, synced: 0 })
    else invalid++
  }
  // v1 exports have no `shared`; malformed entries are dropped silently (the
  // ops still import, only the sync re-link is skipped for that group).
  const shared: SharedRef[] = Array.isArray(envelope.shared)
    ? (envelope.shared as unknown[]).filter(
        (s): s is SharedRef =>
          typeof s === 'object' && s !== null &&
          typeof (s as SharedRef).groupId === 'string' && (s as SharedRef).groupId.length > 0 &&
          typeof (s as SharedRef).shareCode === 'string' && (s as SharedRef).shareCode.length > 0,
      )
    : []
  return { ops, invalid, shared }
}

export interface ImportResult {
  imported: number // new ops folded in
  existing: number // ops already on this device (untouched)
  invalid: number // malformed entries skipped
  relinked: number // shared groups whose sync was re-activated from the export
}

/**
 * Replay an export file into the local log. Idempotent: ops already present are
 * left untouched (their synced flag included). New ops arrive unsynced, so the
 * sync engine re-pushes them to the server for any shared group.
 *
 * Groups the export marks as shared get their syncState re-created (cursor 0),
 * so restoring on a fresh device re-links sync instead of leaving the group
 * silently local-only. Existing syncState rows are never touched, and the
 * self-heal path covers a stale share code (the server re-registers by id).
 */
export async function importJsonExport(text: string, database: ArdoiseDB = db): Promise<ImportResult> {
  const { ops, invalid, shared } = parseJsonExport(text)
  const ids = ops.map((o) => o.opId)
  const existingIds = new Set(
    (await database.operations.where('opId').anyOf(ids).primaryKeys()) as string[],
  )
  const fresh = ops.filter((o) => !existingIds.has(o.opId))
  if (fresh.length > 0) {
    await ingestOps(database, fresh)
  }
  let relinked = 0
  for (const ref of shared) {
    if (!(await database.syncState.get(ref.groupId))) {
      await database.syncState.put({ groupId: ref.groupId, cursor: 0, shareCode: ref.shareCode })
      relinked++
    }
  }
  if (fresh.length > 0 || relinked > 0) {
    emitLocalChange() // let the sync engine push/pull promptly
  }
  return { imported: fresh.length, existing: existingIds.size, invalid, relinked }
}

function csvField(value: string): string {
  // Spreadsheet programs execute formula-looking text even when CSV-quoted.
  // A leading apostrophe keeps participant names/descriptions as plain text.
  const safe = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value
  if (/[";\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`
  return safe
}

const amount = (cents: number) => (cents / 100).toFixed(2).replace('.', ',')

/**
 * Human-readable CSV of a group's expenses. Semicolon-delimited and comma
 * decimals so French Excel opens it cleanly. One row per expense; the
 * "Repartition" column lists each participant's owed share.
 */
export function buildCsvExport(members: Member[], expenses: Expense[]): string {
  // Same graceful fallback as the UI (D22): a member removed on another device
  // can still be referenced by an expense; never print a bare "?".
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? 'Ancien participant'
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
  const sync = await db.syncState.get(groupId)
  const shared = sync ? [{ groupId, shareCode: sync.shareCode }] : []
  download(`ardoise-${slug(groupName)}-${today()}.json`, 'application/json', buildJsonExport(groupName, ops, shared))
}

export async function exportAllJson(): Promise<void> {
  const ops = await db.operations.toArray()
  const shared = (await db.syncState.toArray()).map((s) => ({ groupId: s.groupId, shareCode: s.shareCode }))
  download(`ardoise-tout-${today()}.json`, 'application/json', buildJsonExport('tout', ops, shared))
}

export async function exportGroupCsv(groupId: string): Promise<void> {
  const ops = await db.operations.where('groupId').equals(groupId).toArray()
  const state = foldOps(ops)
  const groupName = state.groups[groupId]?.name ?? 'groupe'
  const csv = buildCsvExport(activeMembers(state, groupId), activeExpenses(state, groupId))
  // BOM so Excel detects UTF-8 accents.
  download(`ardoise-${slug(groupName)}-${today()}.csv`, 'text/csv;charset=utf-8', '﻿' + csv)
}
