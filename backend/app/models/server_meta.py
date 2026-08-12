from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ServerMeta(Base):
    """Identity of this database generation, used by clients to detect a wipe."""

    __tablename__ = "server_meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    generation: Mapped[str] = mapped_column(String(36), nullable=False)
