from datetime import datetime, timezone

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Group(Base):
    """
    Minimal server-side record of a group, used only for share-code discovery
    so a second device can find the group and start pulling its operations.
    The group's real state (name, members, expenses) lives in the operation log,
    not here; this table never holds expense data.
    """

    __tablename__ = "groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    share_code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
