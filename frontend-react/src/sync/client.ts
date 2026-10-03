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
export const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1'

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
export type AuthCheckResult = 'ok' | 'rejected' | 'unreachable'

export async function checkApiKey(key: string): Promise<AuthCheckResult> {
  try {
    const res = await fetch(`${API_BASE}/system/auth-check`, {
      signal: requestTimeout(),
      headers: { 'X-API-Key': key },
    })
    return res.ok ? 'ok' : 'rejected'
  } catch {
    return 'unreachable'
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

/** One round trip: push `ops` and pull everything new since `since` in the
 *  same request (replaces the old push-then-pull pair). `accepted` counts the
 *  ops actually stored (duplicates are not re-stored but are still accepted). */
export function syncOps(
  groupId: string,
  ops: WireOp[],
  since: number,
  reseed = false,
): Promise<{ accepted: number; ops: WireOp[]; cursor: number; serverGeneration: string }> {
  return request(`/groups/${groupId}/sync`, {
    method: 'POST',
    body: JSON.stringify({ ops, since, reseed }),
  })
}

/**
 * Open a wake stream. `EventSource` cannot send the X-API-Key header, hence
 * fetch + ReadableStream. Rejects on non-2xx (e.g. 401/404 as a SyncError).
 */
async function openSse(url: string, signal: AbortSignal): Promise<Response> {
  const key = getApiKey()
  let res: Response
  try {
    res = await fetch(url, {
      signal,
      headers: { Accept: 'text/event-stream', ...(key ? { 'X-API-Key': key } : {}) },
    })
  } catch (e) {
    throw new SyncError(e instanceof Error ? e.message : 'network error')
  }
  if (!res.ok || !res.body) throw new SyncError(`HTTP ${res.status}`, res.status)
  return res
}

/**
 * Shared SSE body reader for both wake streams. Frames are separated by a
 * blank line; a frame may arrive split across chunks, so buffer until the
 * terminator is complete. Comments (": connected", ": keepalive") arrive as
 * ('message', '') and are ignored by the callers. Resolves when the stream
 * ends (server close, proxy idle timeout, network drop); the caller
 * reconnects with backoff.
 */
async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        let event = 'message'
        let data = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        onFrame(event, data)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Live wake-up: `/groups/{id}/events` is an SSE stream on which the server
 * sends a minimal `event: op` frame (`{"seq": N}`) whenever new ops land for
 * the group. The frame carries only the wake-up, never the data: the caller
 * re-syncs to get the actual ops.
 *
 * Resolves when the stream ends (server close, proxy idle timeout, network
 * drop); the caller is expected to reconnect with backoff. Rejects on non-2xx
 * (e.g. 401/404 as a SyncError). Aborting the signal ends the stream cleanly.
 */
export async function openEventStream(groupId: string, onOp: () => void, signal: AbortSignal): Promise<void> {
  const res = await openSse(`${API_BASE}/groups/${encodeURIComponent(groupId)}/events`, signal)
  try {
    await readSseFrames(res.body!, (event, data) => {
      // Only a clean `op` wake-up matters; anything else is covered by the
      // re-sync itself + the polling fallback.
      if (event === 'op' && data) onOp()
    })
  } catch (e) {
    // Aborting ends the stream cleanly; anything else is a real error.
    if (signal.aborted) return
    throw e
  }
}

/**
 * One live wake-up stream for ALL of a group list (Rust endpoint
 * `/groups/events?groups=a,b,c`): a user in G groups holds 1 connection
 * instead of G. Frame: `event: op` + `data: {"group":"<id>","seq":N}` — the
 * wake-up names its group; the caller re-syncs to get the actual ops.
 *
 * The Python backend has no such endpoint (404); `useSync` falls back to one
 * stream per group in that case. Same abort/reconnect contract as
 * `openEventStream`.
 */
export async function openGroupEventStreams(
  groupIds: string[],
  onOp: (groupId: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const qs = groupIds.map((g) => encodeURIComponent(g)).join(',')
  const res = await openSse(`${API_BASE}/groups/events?groups=${qs}`, signal)
  try {
    await readSseFrames(res.body!, (event, data) => {
      if (event !== 'op' || !data) return
      try {
        const frame = JSON.parse(data) as { group?: string }
        if (frame.group) onOp(frame.group)
      } catch {
        /* malformed frame (proxy interference): skip, re-sync covers it */
      }
    })
  } catch (e) {
    if (signal.aborted) return
    throw e
  }
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
