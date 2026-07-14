from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.push_subscription import PushSubscription
from app.schemas.push import SubscribeRequest, UnsubscribeRequest, VapidPublicKeyOut
from app.services.push_service import push_enabled, vapid_public_key

router = APIRouter()


def _require_push_enabled() -> None:
    if not push_enabled():
        # 503: the instance simply has no VAPID key configured. The client
        # hides the notification menu entry when it sees this.
        raise HTTPException(status_code=503, detail="Notifications non configurees sur ce serveur")


@router.get("/vapid-public-key", response_model=VapidPublicKeyOut)
def get_vapid_public_key():
    """The applicationServerKey the browser needs to subscribe."""
    _require_push_enabled()
    return VapidPublicKeyOut(public_key=vapid_public_key())


@router.post("/subscribe")
def subscribe(body: SubscribeRequest, db: Session = Depends(get_db)):
    """
    Register (or refresh) this browser's push subscription. Idempotent upsert
    keyed by endpoint; the client re-sends it whenever its group list changes.
    """
    _require_push_enabled()
    sub = db.get(PushSubscription, body.endpoint)
    if sub is None:
        sub = PushSubscription(endpoint=body.endpoint)
        db.add(sub)
    sub.p256dh = body.keys.p256dh
    sub.auth = body.keys.auth
    sub.device_id = body.device_id
    sub.group_ids = body.group_ids
    sub.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@router.post("/unsubscribe")
def unsubscribe(body: UnsubscribeRequest, db: Session = Depends(get_db)):
    """Forget a subscription. Idempotent: unknown endpoints are a no-op."""
    sub = db.get(PushSubscription, body.endpoint)
    if sub is not None:
        db.delete(sub)
        db.commit()
    return {"ok": True}
