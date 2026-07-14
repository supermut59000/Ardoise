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

    def push(self, group_id: str, ops: List[OperationWire]) -> Tuple[int, int]:
        """
        Store incoming ops idempotently (dedup by op_id). Returns
        (accepted_count, current_max_cursor). The server never mutates or reorders
        ops; it only appends new ones.
        """
        if not ops:
            return 0, self.max_cursor(group_id)

        incoming_ids = [o.op_id for o in ops]
        existing = {
            row[0]
            for row in self.db.query(Operation.op_id)
            .filter(Operation.op_id.in_(incoming_ids))
            .all()
        }

        accepted = 0
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
            accepted += 1

        self.db.commit()
        return accepted, self.max_cursor(group_id)

    def pull(self, group_id: str, since: int) -> Tuple[List[Operation], int]:
        """Return ops with seq > since, in seq order, plus the new max cursor."""
        rows = (
            self.db.query(Operation)
            .filter(Operation.group_id == group_id, Operation.seq > since)
            .order_by(Operation.seq.asc())
            .all()
        )
        cursor = rows[-1].seq if rows else since
        return rows, cursor
