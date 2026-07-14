import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { activeExpenses, activeMembers, activeSettlements, foldOps } from '@/sync/fold'
import { computeBalances, referencedMemberIds } from '@/domain/balances'
import { simplifyDebts } from '@/domain/simplify-debts'
import type { Balance, Expense, Group, Member, Settlement, Transfer } from '@/domain/types'

export interface GroupData {
  group: Group | undefined
  members: Member[]
  expenses: Expense[]
  settlements: Settlement[]
  balances: Balance[]
  transfers: Transfer[]
  /** Member ids that appear in a depense/remboursement (cannot be removed yet). */
  referenced: Set<string>
}

/**
 * Everything one group screen needs, folded live from only that group's ops.
 * `undefined` while the first query is in flight.
 */
export function useGroupData(groupId: string): GroupData | undefined {
  return useLiveQuery(async () => {
    // Filter by the groupId index so we only fold this group's slice of the log.
    const ops = await db.operations.where('groupId').equals(groupId).toArray()
    const state = foldOps(ops)
    const members = activeMembers(state, groupId)
    const expenses = activeExpenses(state, groupId)
    const settlements = activeSettlements(state, groupId)
    const balances = computeBalances(members, expenses, settlements)
    const transfers = simplifyDebts(balances)
    const referenced = referencedMemberIds(expenses, settlements)
    return { group: state.groups[groupId], members, expenses, settlements, balances, transfers, referenced }
  }, [groupId])
}
