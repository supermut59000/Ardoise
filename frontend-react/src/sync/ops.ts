import { bumpLamport, db, type ArdoiseDB } from '@/db/dexie'
import type { ExpenseShare, SplitMode } from '@/domain/types'
import { newId, type Action, type Entity, type Operation } from './operation'
import { emitLocalChange } from './events'

/**
 * Append one operation atomically: bump the lamport clock and write the op in a
 * single rw transaction so the clock and the log never disagree, even if two
 * mutations fire back-to-back.
 */
async function appendOp(
  database: ArdoiseDB,
  args: {
    groupId: string
    entity: Entity
    entityId: string
    action: Action
    payload: Record<string, unknown>
  },
): Promise<Operation> {
  return database.transaction('rw', database.meta, database.operations, async () => {
    const { lamport, deviceId } = await bumpLamport(database)
    const op: Operation = {
      opId: newId(),
      groupId: args.groupId,
      entity: args.entity,
      entityId: args.entityId,
      action: args.action,
      payload: args.payload,
      actor: deviceId,
      lamport,
      createdAt: Date.now(),
      synced: 0,
    }
    await database.operations.add(op)
    return op
  })
}

async function appendAndNotify(
  database: ArdoiseDB,
  args: Parameters<typeof appendOp>[1],
): Promise<Operation> {
  const op = await appendOp(database, args)
  emitLocalChange() // nudge the sync engine to push this promptly
  return op
}

// ---- Group ----

export async function createGroup(
  input: { name: string; currency?: string },
  database: ArdoiseDB = db,
): Promise<string> {
  const groupId = newId()
  await appendAndNotify(database, {
    groupId,
    entity: 'group',
    entityId: groupId,
    action: 'create',
    payload: { groupId, name: input.name, currency: input.currency ?? 'EUR', createdAt: Date.now() },
  })
  return groupId
}

export async function renameGroup(groupId: string, name: string, database: ArdoiseDB = db) {
  await appendAndNotify(database, { groupId, entity: 'group', entityId: groupId, action: 'update', payload: { name } })
}

export async function deleteGroup(groupId: string, database: ArdoiseDB = db) {
  await appendAndNotify(database, { groupId, entity: 'group', entityId: groupId, action: 'delete', payload: {} })
}

// ---- Member ----

export async function addMember(
  groupId: string,
  name: string,
  database: ArdoiseDB = db,
): Promise<string> {
  const memberId = newId()
  await appendAndNotify(database, {
    groupId,
    entity: 'member',
    entityId: memberId,
    action: 'create',
    payload: { groupId, name, createdAt: Date.now() },
  })
  return memberId
}

export async function renameMember(groupId: string, memberId: string, name: string, database: ArdoiseDB = db) {
  await appendAndNotify(database, { groupId, entity: 'member', entityId: memberId, action: 'update', payload: { name } })
}

export async function removeMember(groupId: string, memberId: string, database: ArdoiseDB = db) {
  await appendAndNotify(database, { groupId, entity: 'member', entityId: memberId, action: 'delete', payload: {} })
}

// ---- Expense ----

export interface ExpenseInput {
  description: string
  amountCents: number
  paidBy: string
  spentAt: string // ISO date
  emoji?: string // '' = none; the form always carries it so clearing syncs (LWW per field)
  brand?: string // '' = none; same rule as emoji
  splitMode?: SplitMode // defaults to 'equal'
  shares: ExpenseShare[]
}

export async function addExpense(
  groupId: string,
  input: ExpenseInput,
  database: ArdoiseDB = db,
): Promise<string> {
  const expenseId = newId()
  await appendAndNotify(database, {
    groupId,
    entity: 'expense',
    entityId: expenseId,
    action: 'create',
    payload: {
      groupId,
      description: input.description,
      amountCents: input.amountCents,
      paidBy: input.paidBy,
      spentAt: input.spentAt,
      emoji: input.emoji ?? '',
      brand: input.brand ?? '',
      splitMode: input.splitMode ?? 'equal',
      shares: input.shares,
      createdAt: Date.now(),
    },
  })
  return expenseId
}

export async function updateExpense(
  groupId: string,
  expenseId: string,
  patch: Partial<ExpenseInput>,
  database: ArdoiseDB = db,
) {
  await appendAndNotify(database, { groupId, entity: 'expense', entityId: expenseId, action: 'update', payload: { ...patch } })
}

export async function deleteExpense(groupId: string, expenseId: string, database: ArdoiseDB = db) {
  await appendAndNotify(database, { groupId, entity: 'expense', entityId: expenseId, action: 'delete', payload: {} })
}

// ---- Settlement (recorded repayment) ----

export interface SettlementInput {
  fromMemberId: string
  toMemberId: string
  amountCents: number
  settledAt: string // ISO date
}

export async function addSettlement(
  groupId: string,
  input: SettlementInput,
  database: ArdoiseDB = db,
): Promise<string> {
  const settlementId = newId()
  await appendAndNotify(database, {
    groupId,
    entity: 'settlement',
    entityId: settlementId,
    action: 'create',
    payload: {
      groupId,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      amountCents: input.amountCents,
      settledAt: input.settledAt,
      createdAt: Date.now(),
    },
  })
  return settlementId
}

export async function deleteSettlement(groupId: string, settlementId: string, database: ArdoiseDB = db) {
  await appendAndNotify(database, { groupId, entity: 'settlement', entityId: settlementId, action: 'delete', payload: {} })
}
