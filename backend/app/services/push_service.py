"""
Web Push notifications for group activity.

The server stays a dumb relay for STATE (it never folds ops), but it is the only
node that sees everyone's pushes, so it is the natural place to fan out "your
group changed" notifications. Messages are built from the op payloads alone
(the server still holds no folded state).

Disabled cleanly when VAPID_PRIVATE_KEY is unset: notify() is a no-op and the
subscribe endpoints answer 503. pywebpush/py_vapid are imported lazily so the
backend still boots on an image built before this feature.
"""

import json
import logging
from functools import lru_cache
from typing import Callable, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.operation import Operation
from app.models.push_subscription import PushSubscription
from app.schemas.sync import OperationWire

logger = logging.getLogger(__name__)

# lookup(entity, entity_id, field) -> the latest known payload value, or None.
# Lets messages name things a lone op does not carry (a delete op has an empty
# payload; the expense's description lives in its earlier create/update ops).
Lookup = Callable[[str, Optional[str], str], Optional[str]]


def push_enabled() -> bool:
    return bool(settings.VAPID_PRIVATE_KEY)


@lru_cache(maxsize=1)
def vapid_public_key() -> str:
    """
    Derive the base64url uncompressed-point public key (the browser's
    `applicationServerKey`) from the configured raw private key.
    """
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid02, b64urlencode

    vapid = Vapid02.from_string(settings.VAPID_PRIVATE_KEY)
    raw = vapid.private_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return b64urlencode(raw)


def _amount(payload: dict) -> str:
    cents = payload.get("amountCents")
    if not isinstance(cents, (int, float)):
        return ""
    return f"{cents / 100:.2f}".replace(".", ",") + " EUR"


def _latest_payload_field(
    db: Session, group_id: str, entity: str, field: str, entity_id: Optional[str] = None
) -> Optional[str]:
    """
    Latest known payload value for a field, in fold order (lamport desc). Not a
    state merge, just a display lookup: e.g. the group's current name, or the
    description of an expense whose delete op carries an empty payload.
    """
    q = db.query(Operation).filter(
        Operation.group_id == group_id, Operation.entity == entity
    )
    if entity_id is not None:
        q = q.filter(Operation.entity_id == entity_id)
    # Match the client fold exactly: equal Lamports are resolved by op_id,
    # never by server arrival order (seq).
    for row in q.order_by(Operation.lamport.desc(), Operation.op_id.desc()).all():
        value = (row.payload or {}).get(field)
        if value:
            return str(value)
    return None


def build_body(ops: List[OperationWire], lookup: Lookup) -> str:
    """
    French notification body for a batch of ops pushed to one group (the group
    name goes in the TITLE, resolved by the caller). Single-op batches get a
    specific message naming the thing that changed, falling back to `lookup`
    when the op's own payload does not carry it (deletes); larger batches
    collapse into a count.
    """
    if len(ops) == 1:
        op = ops[0]
        p = op.payload or {}

        def known(field: str) -> str:
            return str(
                p.get(field) or lookup(op.entity, op.entity_id, field) or ""
            ).strip()

        if op.entity == "expense":
            desc = known("description")
            if op.action == "create":
                base = f"Nouvelle depense : {desc}" if desc else "Nouvelle depense"
                amt = _amount(p)
                return f"{base} ({amt})" if amt else base
            if op.action == "update":
                return f"Depense modifiee : {desc}" if desc else "Depense modifiee"
            return f"Depense supprimee : {desc}" if desc else "Depense supprimee"
        if op.entity == "settlement":
            if op.action == "create":
                amt = _amount(p)
                return (
                    f"Remboursement enregistre : {amt}"
                    if amt
                    else "Remboursement enregistre"
                )
            return "Remboursement annule"
        if op.entity == "member":
            name = known("name")
            if op.action == "create":
                return (
                    f"Nouveau participant : {name}" if name else "Nouveau participant"
                )
            if op.action == "update":
                return (
                    f"Participant renomme : {name}" if name else "Participant renomme"
                )
            return f"Participant retire : {name}" if name else "Participant retire"
        if op.entity == "group":
            if op.action == "update" and p.get("name"):
                return f"Groupe renomme : {p['name']}"
            if op.action == "delete":
                return "Groupe supprime"
    n = len(ops)
    return f"{n} modification{'s' if n > 1 else ''}"


def _send(subscription: PushSubscription, payload: str) -> Optional[int]:
    """Send one notification. Returns an HTTP status when the push service
    rejected the subscription (404/410 = gone), None on success."""
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info={
                "endpoint": subscription.endpoint,
                "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
            },
            data=payload,
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims={"sub": settings.VAPID_SUBJECT},
            ttl=3600,  # stale group-activity pings are worthless after an hour
        )
        return None
    except WebPushException as e:
        status = e.response.status_code if e.response is not None else 0
        logger.warning(
            "web push failed (%s) for %s", status, subscription.endpoint[:60]
        )
        return status


# Above this many newly-accepted ops, the push is a reseed/catch-up (self-heal
# after a server wipe, import replay), not live activity: notifying "300
# modifications" would only confuse people, so we stay silent.
NOTIFY_MAX_BATCH = 50


def notify_task(group_id: str, excluded_actors: set, ops: List[OperationWire]) -> None:
    """FastAPI background-task entrypoint: runs after the sync response is sent,
    with its own DB session (the request's session is closed by then)."""
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        notify_group(db, group_id, excluded_actors, ops)
    except Exception:
        logger.exception("push notification fan-out failed")
    finally:
        db.close()


def notify_group(
    db: Session, group_id: str, excluded_actors: set, ops: List[OperationWire]
) -> int:
    """
    Notify every subscribed device that follows `group_id`, except the devices
    that authored the ops. A batch may carry ops from several devices (e.g. a
    self-heal re-push of ops pulled from peers), so every author's device is
    excluded; excluding only one would let the healing device notify itself.
    Dead subscriptions (404/410 from the push service) are pruned. Runs as a
    FastAPI background task, after the push response is sent, so a slow push
    service never delays sync. Returns the number of sends attempted.
    """
    if not push_enabled() or not ops:
        return 0

    # Title = the group's name so people always know WHICH ardoise moved;
    # body = what happened. Both resolved from the op log alone.
    def lookup(entity: str, entity_id: Optional[str], field: str) -> Optional[str]:
        return _latest_payload_field(db, group_id, entity, field, entity_id)

    title = _latest_payload_field(db, group_id, "group", "name") or "Ardoise"
    body = build_body(ops, lookup)
    payload = json.dumps({"title": title, "body": body, "groupId": group_id})

    # Friends-scale table: filter in Python rather than JSON-querying MariaDB.
    targets = [
        s
        for s in db.query(PushSubscription).all()
        if s.device_id not in excluded_actors and group_id in (s.group_ids or [])
    ]
    sent = 0
    for sub in targets:
        status = _send(sub, payload)
        if status in (404, 410):
            db.delete(sub)  # subscription expired or revoked: forget it
        sent += 1
    db.commit()
    return sent
