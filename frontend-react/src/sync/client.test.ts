import { describe, it, expect, vi, afterEach } from 'vitest'
import { openEventStream, SyncError } from './client'

/** Build a fake SSE response whose body streams the given chunks then closes. */
function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openEventStream', () => {
  it('fires onOp for each op frame, ignores comments/keepalives, resolves on close', async () => {
    const onOp = vi.fn()
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        ': connected\n\n',
        'event: op\ndata: {"seq":1}\n\n',
        ': keepalive\n\n',
        'event: op\ndata: {"seq":', // frame split across chunks, like the wire
        '2}\n\n',
        'event: op\ndata: {"seq":3}\n\n',
      ]),
    ) as typeof fetch

    await openEventStream('g1', onOp, new AbortController().signal)

    expect(onOp).toHaveBeenCalledTimes(3)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toContain('/groups/g1/events')
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['Accept']).toBe('text/event-stream')
  })

  it('rejects with SyncError on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => sseResponse([], 401)) as typeof fetch
    await expect(openEventStream('g1', () => {}, new AbortController().signal)).rejects.toMatchObject({
      status: 401,
      name: 'SyncError',
    })
  })

  it('resolves cleanly when aborted mid-stream, after delivering earlier wakes', async () => {
    const ac = new AbortController()
    // One wake arrives, then the stream idles. Aborting must error the body
    // (like a real fetch signal) and end the reader cleanly.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: op\ndata: {"seq":1}\n\n'))
        ac.signal.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'))
        })
      },
    })
    globalThis.fetch = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    ) as typeof fetch

    const onOp = vi.fn()
    const p = openEventStream('g1', onOp, ac.signal)
    await vi.waitFor(() => expect(onOp).toHaveBeenCalledTimes(1))
    ac.abort()
    await expect(p).resolves.toBeUndefined()
    expect(onOp).toHaveBeenCalledTimes(1)
  })
})

describe('SyncError', () => {
  it('carries the HTTP status', () => {
    expect(new SyncError('nope', 404).status).toBe(404)
  })
})
