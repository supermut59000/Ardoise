from uuid import uuid4

from sqlalchemy.orm import Session

from app.models.server_meta import ServerMeta


def server_generation(db: Session) -> str:
    """Stable for one DB lifetime; changes when a wiped DB is recreated."""
    row = db.get(ServerMeta, 1)
    if row is None:
        row = ServerMeta(id=1, generation=str(uuid4()))
        db.add(row)
        db.commit()
    return row.generation
