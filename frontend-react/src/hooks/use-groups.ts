import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { activeGroups, foldOps } from '@/sync/fold'
import type { Group } from '@/domain/types'

/** All non-deleted groups, newest first. Recomputes live as operations change. */
export function useGroups(): Group[] | undefined {
  return useLiveQuery(async () => {
    const ops = await db.operations.toArray()
    return activeGroups(foldOps(ops))
  }, [])
}
