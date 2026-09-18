import asyncio
import json

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas.sync import (
    OperationWire,
    PullResponse,
    PushRequest,
    PushResponse,
    SyncRequest,
    SyncResponse,
)
from app.services import event_bus
from app.services.group_service import GroupService
from app.services.push_service import NOTIFY_MAX_BATCH, notify_task, push_enabled
from app.services.sync_service import SyncService
from app.services.server_meta_service import server_generation

router = APIRouter()


@router.post("/{group_id}/ops", response_model=PushResponse)
def push_ops(
    group_id: str,
    body: PushRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    # The group must be registered (via the share flow) before it can sync.
    if not GroupService(db).get(group_id):
        raise HTTPException(status_code=404, detail="Groupe non enregistre")
    accepted, cursor = SyncService(db).push(group_id, body.ops)
    # Fan out "group changed" notifications AFTER the response, never blocking
    # sync. Only for genuinely new ops, only for live-sized batches (a reseed
    # after self-heal would otherwise ping everyone with a meaningless count),
    # and never for a client-flagged reseed push. Every author in the batch is
    # excluded: a self-heal re-push can carry ops from several devices, and
    # excluding only the first would let the healing device notify itself.
    if (
        accepted
        and len(accepted) <= NOTIFY_MAX_BATCH
        and push_enabled()
        and not body.reseed
    ):
        background_tasks.add_task(
            notify_task, group_id, {o.actor for o in accepted}, accepted
        )
    # SSE wake-up: genuinely new ops only (dedup and reseed pushes create no
    # new rows, so other devices have nothing to sync).
    if accepted and not body.reseed:
        event_bus.publish(group_id, {"seq": cursor})
    return PushResponse(accepted=len(accepted), cursor=cursor)


def _to_wire(r) -> OperationWire:
    return OperationWire(
        opId=r.op_id,
        groupId=r.group_id,
        entity=r.entity,
        entityId=r.entity_id,
        action=r.action,
        payload=r.payload,
        actor=r.actor,
        lamport=r.lamport,
        createdAt=r.created_at,
    )


@router.get("/{group_id}/ops", response_model=PullResponse)
def pull_ops(
    group_id: str,
    since: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    if not GroupService(db).get(group_id):
        raise HTTPException(status_code=404, detail="Groupe non enregistre")
    rows, cursor = SyncService(db).pull(group_id, since)
    return PullResponse(
        ops=[_to_wire(r) for r in rows], cursor=cursor, server_generation=server_generation(db)
    )


@router.post("/{group_id}/sync", response_model=SyncResponse)
def sync_ops(
    group_id: str,
    body: SyncRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Push + pull in ONE round trip: applies `ops` with the exact push semantics
    (idempotent dedup by opId, same 404 for an unregistered group, same
    notification fan-out rules), then returns everything with seq > `since` —
    including the ops just accepted, so the device learns the seq of its own
    ops without a second request.
    """
    if not GroupService(db).get(group_id):
        raise HTTPException(status_code=404, detail="Groupe non enregistre")
    svc = SyncService(db)
    accepted, _ = svc.push(group_id, body.ops)
    rows, cursor = svc.pull(group_id, body.since)
    if (
        accepted
        and len(accepted) <= NOTIFY_MAX_BATCH
        and push_enabled()
        and not body.reseed
    ):
        background_tasks.add_task(
            notify_task, group_id, {o.actor for o in accepted}, accepted
        )
    if accepted and not body.reseed:
        event_bus.publish(group_id, {"seq": cursor})
    return SyncResponse(
        accepted=len(accepted),
        ops=[_to_wire(r) for r in rows],
        cursor=cursor,
        server_generation=server_generation(db),
    )


@router.get("/{group_id}/events")
async def group_events(group_id: str, request: Request, db: Session = Depends(get_db)):
    """
    Server-Sent Events: a minimal wake-up ("an op with seq N landed") every
    time a new op is accepted for this group. The payload is NOT the op data —
    the client reacts by running its normal sync pull, so the cursor/fold code
    path stays single. Auth is the X-API-Key header (the router-level
    dependency), which is why clients must consume this with fetch() +
    ReadableStream: the browser EventSource cannot set custom headers.
    """
    if not GroupService(db).get(group_id):
        raise HTTPException(status_code=404, detail="Groupe non enregistre")
    event_bus.bind_loop(asyncio.get_running_loop())
    queue = event_bus.subscribe(group_id)

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"event: op\ndata: {json.dumps(evt)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            event_bus.unsubscribe(group_id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
