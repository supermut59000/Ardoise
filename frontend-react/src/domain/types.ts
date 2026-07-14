// Core domain types. All money is integer cents, never floats.

export interface Group {
  id: string
  name: string
  currency: string
  createdAt: number
  deleted?: boolean
}

export interface Member {
  id: string
  groupId: string
  name: string
  createdAt: number
  deleted?: boolean
}

/**
 * How an expense is split. The meaning of ExpenseShare.weight depends on the mode:
 *   equal   -> weight is 1 for each participant
 *   shares  -> weight is the number of parts (e.g. 2 vs 1)
 *   percent -> weight is a percentage (must total 100)
 *   exact   -> weight is the exact cents that member owes (must total the amount)
 */
export type SplitMode = 'equal' | 'shares' | 'percent' | 'exact'

export interface ExpenseShare {
  memberId: string
  weight: number
}

export interface Expense {
  id: string
  groupId: string
  description: string
  amountCents: number
  paidBy: string // member id
  spentAt: string // ISO date (YYYY-MM-DD)
  splitMode?: SplitMode // absent on Phase 1 expenses -> treated as 'equal'
  shares: ExpenseShare[]
  createdAt: number
  deleted?: boolean
}

/** A recorded real-world repayment: fromMember handed toMember cash. */
export interface Settlement {
  id: string
  groupId: string
  fromMemberId: string
  toMemberId: string
  amountCents: number
  settledAt: string // ISO date
  createdAt: number
  deleted?: boolean
}

/** Full derived state, produced by folding the operation log. */
export interface AppState {
  groups: Record<string, Group>
  members: Record<string, Member>
  expenses: Record<string, Expense>
  settlements: Record<string, Settlement>
}

/** One member's net position in a group: positive = is owed, negative = owes. */
export interface Balance {
  memberId: string
  netCents: number
}

/** A single "who pays whom" transfer produced by simplify-debts. */
export interface Transfer {
  fromMemberId: string
  toMemberId: string
  amountCents: number
}
