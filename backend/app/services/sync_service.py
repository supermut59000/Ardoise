from typing import List, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.operation import Operation
from app.schemas.sync import OperationWire


class SyncService:
    def __init__(self, db: Session):
        self.db = db

    def max_cursor(self, group_id: str) -> int:
        value = (
            self.db.query(func.max(Operation.seq))
            .filter(Operation.group_id == group_id)
            .scalar()
        )
        return int(value or 0)

    def push(self, group_id: str, ops: List[OperationWire]) -> Tuple[List[OperationWire], int]:
        """
        Store incoming ops idempotently (dedup by op_id). Returns
        (newly_accepted_ops, current_max_cursor); duplicates are ignored. The
        accepted list (not just a count) feeds the push-notification fan-out.
        The server never mutates or reorders ops; it only appends new ones.
        """
        if not ops:
            return [], self.max_cursor(group_id)

        incoming_ids = [o.op_id for o in ops]
        existing = {
            row[0]
            for row in self.db.query(Operation.op_id)
            .filter(Operation.op_id.in_(incoming_ids))
            .all()
        }

        accepted: List[OperationWire] = []
        for o in ops:
            if o.op_id in existing:
                continue
            self.db.add(
                Operation(
                    op_id=o.op_id,
                    group_id=group_id,
                    entity=o.entity,
                    entity_id=o.entity_id,
                    action=o.action,
                    payload=o.payload,
                    actor=o.actor,
                    lamport=o.lamport,
                    created_at=o.created_at,
                )
            )
            existing.add(o.op_id)  # guard against duplicates within one request
            accepted.append(o)

        self.db.commit()
        return accepted, self.max_cursor(group_id)

    def pull(self, group_id: str, since: int) -> Tuple[List[Operation], int]:
        """
        Return ops with seq > since, in seq order, plus the group's current max
        cursor. On an empty result the REAL max is returned (not `since` echoed
        back): a client whose cursor is ahead of the server (DB restored from an
        older backup) sees cursor < since and knows to reset and re-sync.
        """
        rows = (
            self.db.query(Operation)
            .filter(Operation.group_id == group_id, Operation.seq > since)
            .order_by(Operation.seq.asc())
            .all()
        )
        cursor = rows[-1].seq if rows else self.max_cursor(group_id)
        return rows, cursor
