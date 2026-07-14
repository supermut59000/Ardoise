from datetime import datetime, timezone

from sqlalchemy import JSON, BigInteger, DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Operation(Base):
    """
    Append-only operation log. This is the single source of truth the server holds.

    - `seq`  : server-assigned monotonic order; clients pull with `?since={seq}`.
    - `op_id`: client-generated UUID, unique, gives idempotent push (re-pushing is a no-op).
    - state = clients folding operations in (lamport, op_id) order; the server never folds.
    """

    __tablename__ = "operations"

    # BigInteger on MariaDB; INTEGER on SQLite so its rowid autoincrement works
    # (SQLite only auto-increments INTEGER PRIMARY KEY, not BIGINT).
    seq: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    op_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    group_id: Mapped[str] = mapped_column(String(36), index=True)

    entity: Mapped[str] = mapped_column(String(20))      # expense | member | settlement | group
    entity_id: Mapped[str] = mapped_column(String(36))
    action: Mapped[str] = mapped_column(String(10))      # create | update | delete
    payload: Mapped[dict] = mapped_column(JSON)

    actor: Mapped[str] = mapped_column(String(64))       # device / member id
    lamport: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger)  # client wall clock (ms epoch)
    received_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )

    __table_args__ = (
        # Pull path: "give me this group's ops after cursor N, in order".
        Index("ix_operations_group_seq", "group_id", "seq"),
    )
