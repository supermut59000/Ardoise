from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas.sync import OperationWire, PullResponse, PushRequest, PushResponse
from app.services.group_service import GroupService
from app.services.push_service import NOTIFY_MAX_BATCH, notify_task, push_enabled
from app.services.sync_service import SyncService

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
    # after self-heal would otherwise ping everyone with a meaningless count).
    if accepted and len(accepted) <= NOTIFY_MAX_BATCH and push_enabled():
        background_tasks.add_task(notify_task, group_id, accepted[0].actor, accepted)
    return PushResponse(accepted=len(accepted), cursor=cursor)


@router.get("/{group_id}/ops", response_model=PullResponse)
def pull_ops(
    group_id: str,
    since: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    if not GroupService(db).get(group_id):
        raise HTTPException(status_code=404, detail="Groupe non enregistre")
    rows, cursor = SyncService(db).pull(group_id, since)
    ops = [
        OperationWire(
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
        for r in rows
    ]
    return PullResponse(ops=ops, cursor=cursor)
