from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PushSubscription(Base):
    """
    One browser's Web Push subscription. Device-scoped, like identity: it never
    syncs through the op log. `group_ids` is the list of shared groups this
    device wants alerts for (the client re-sends it when groups change).
    `device_id` is the same actor id the ops carry, so the author of a change
    is never notified about their own edit.
    """

    __tablename__ = "push_subscriptions"

    # Push endpoints are long opaque URLs (FCM/APNs web push gateways).
    endpoint: Mapped[str] = mapped_column(String(500), primary_key=True)
    p256dh: Mapped[str] = mapped_column(String(255))
    auth: Mapped[str] = mapped_column(String(255))
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    group_ids: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
