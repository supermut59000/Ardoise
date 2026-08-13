import type { Operation } from './operation'
import { getApiKey } from '@/lib/auth'

/** The over-the-wire operation: exactly our Operation minus the local `synced` flag. */
export type WireOp = Omit<Operation, 'synced'>

export interface GroupInfo {
  groupId: string
  shareCode: string
  serverGeneration: string
}

// Configurable at build time; defaults to a same-origin /api/v1 (prod behind a proxy).
const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1'

export class SyncError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'SyncError'
    this.status = status
  }
}

/** A request that never settles (half-open connection, wedged upstream) would
 *  otherwise hold the sync engine's in-flight lock forever. 15s is generous for
 *  a LAN/homelab round trip; the abort surfaces as a transient SyncError. */
const REQUEST_TIMEOUT_MS = 15_000

function requestTimeout(): AbortSignal | undefined {
  // Older WebViews may lack AbortSignal.timeout; they just skip the guard.
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getApiKey()
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: requestTimeout(),
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': key } : {}),
        ...init?.headers,
      },
    })
  } catch (e) {
    // Network unreachable / offline / timed out: transient, not a rejection.
    throw new SyncError(e instanceof Error ? e.message : 'network error')
  }
  if (res.status === 401) {
    // Missing/wrong shared password. Callers decide whether to prompt.
    throw new SyncError('Mot de passe du serveur requis', 401)
  }
  if (!res.ok) {
    throw new SyncError(`HTTP ${res.status}`, res.status)
  }
  return res.json() as Promise<T>
}

/** Validate a candidate password against the server. Used by the key dialog. */
export async function checkApiKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/system/auth-check`, {
      signal: requestTimeout(),
      headers: { 'X-API-Key': key },
    })
    return res.ok
  } catch {
    return false
  }
}

export function toWire(op: Operation): WireOp {
  return {
    opId: op.opId,
    groupId: op.groupId,
    entity: op.entity,
    entityId: op.entityId,
    action: op.action,
    payload: op.payload,
    actor: op.actor,
    lamport: op.lamport,
    createdAt: op.createdAt,
  }
}

export function registerGroup(groupId: string): Promise<GroupInfo> {
  return request<GroupInfo>('/groups/register', {
    method: 'POST',
    body: JSON.stringify({ groupId }),
  })
}

export function resolveCode(shareCode: string): Promise<GroupInfo> {
  return request<GroupInfo>(`/groups/resolve/${encodeURIComponent(shareCode)}`)
}

export function pushOps(
  groupId: string,
  ops: WireOp[],
  reseed = false,
): Promise<{ accepted: number; cursor: number }> {
  return request(`/groups/${groupId}/ops`, {
    method: 'POST',
    body: JSON.stringify({ ops, reseed }),
  })
}

export function pullOps(
  groupId: string,
  since: number,
): Promise<{ ops: WireOp[]; cursor: number; serverGeneration: string }> {
  return request(`/groups/${groupId}/ops?since=${since}`)
}

// ---- Web Push ----

export function getVapidPublicKey(): Promise<{ publicKey: string }> {
  // 503 (SyncError) when the server has no VAPID key configured.
  return request('/push/vapid-public-key')
}

export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
  deviceId: string
  groupIds: string[]
}

export function subscribePush(body: PushSubscriptionBody): Promise<{ ok: boolean }> {
  return request('/push/subscribe', { method: 'POST', body: JSON.stringify(body) })
}

export function unsubscribePush(endpoint: string): Promise<{ ok: boolean }> {
  return request('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) })
}
