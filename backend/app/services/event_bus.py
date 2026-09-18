"""
In-process group event bus for SSE wake-ups (GET /groups/{id}/events).

Fan-out is intentionally in-process: the production and dev deployments run
a single uvicorn worker (DEPLOY.md). If the backend ever runs multiple
workers, THIS module is the seam to swap in a shared broker — the call
sites (subscribe / unsubscribe / publish) keep the same shape.

Events are minimal wake-ups, not data: a subscriber reacts by running its
normal sync pull, so the cursor/fold code path stays single. Queues are
unbounded because a wake ("sync now") is idempotent — a lagging subscriber
just gets extra wakes that collapse into one sync.
"""

import asyncio
from collections import defaultdict

# group_id -> {id(queue): queue}
_subscribers: dict[str, dict[int, "asyncio.Queue"]] = defaultdict(dict)
# One loop: the single-worker premise above. SSE endpoints bind it on
# subscribe; publishes from sync request threads schedule onto it.
_loop: "asyncio.AbstractEventLoop | None" = None


def bind_loop(loop: "asyncio.AbstractEventLoop") -> None:
    global _loop
    _loop = loop


def subscribe(group_id: str) -> "asyncio.Queue":
    queue: "asyncio.Queue" = asyncio.Queue()
    _subscribers[group_id][id(queue)] = queue
    return queue


def unsubscribe(group_id: str, queue: "asyncio.Queue") -> None:
    _subscribers[group_id].pop(id(queue), None)


def publish(group_id: str, payload: dict) -> None:
    """
    Thread-safe: called from the FastAPI sync-request threadpool, so the
    put is scheduled onto the SSE loop with call_soon_threadsafe. A
    subscriber that vanished between the snapshot and the callback is
    harmless (the queue simply goes unobserved).
    """
    loop = _loop
    subs = _subscribers.get(group_id)
    if loop is None or not subs:
        return
    for queue in list(subs.values()):
        loop.call_soon_threadsafe(queue.put_nowait, payload)
