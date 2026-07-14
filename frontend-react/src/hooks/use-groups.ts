import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { activeExpenses, activeGroups, activeMembers, foldOps } from '@/sync/fold'
import type { Group, Member } from '@/domain/types'

export interface GroupSummary {
  group: Group
  members: Member[]
  totalCents: number
  expenseCount: number
  /** Up to 3 distinct emojis from the most recent expenses, for the home card. */
  recentEmojis: string[]
}

/** Groups with a lightweight per-group summary (members, total, count) for the
 *  home cards. Recomputes live as operations change. */
export function useGroups(): GroupSummary[] | undefined {
  return useLiveQuery(async () => {
    const state = foldOps(await db.operations.toArray())
    return activeGroups(state).map((group) => {
      const expenses = activeExpenses(state, group.id) // already newest-first
      const recentEmojis: string[] = []
      for (const e of expenses) {
        if (e.emoji && !recentEmojis.includes(e.emoji)) {
          recentEmojis.push(e.emoji)
          if (recentEmojis.length === 3) break
        }
      }
      return {
        group,
        members: activeMembers(state, group.id),
        totalCents: expenses.reduce((sum, e) => sum + e.amountCents, 0),
        expenseCount: expenses.length,
        recentEmojis,
      }
    })
  }, [])
}
