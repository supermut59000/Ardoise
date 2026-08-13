import secrets

from sqlalchemy.orm import Session

from app.models.group import Group

# Unambiguous alphabet (no 0/O/1/I/L) for share codes people may type by hand.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _generate_code(length: int = 8) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


class GroupService:
    def __init__(self, db: Session):
        self.db = db

    def register(self, group_id: str) -> Group:
        """
        Register a locally-created group for sharing. Idempotent: if the group is
        already registered, return it unchanged (same share code).
        """
        existing = self.db.get(Group, group_id)
        if existing:
            return existing

        # Retry on the astronomically unlikely share-code collision.
        for _ in range(10):
            code = _generate_code()
            if not self.db.query(Group).filter(Group.share_code == code).first():
                group = Group(id=group_id, share_code=code)
                self.db.add(group)
                self.db.commit()
                self.db.refresh(group)
                return group
        raise RuntimeError("Could not allocate a unique share code")

    def get(self, group_id: str) -> Group | None:
        return self.db.get(Group, group_id)

    def resolve(self, share_code: str) -> Group | None:
        return (
            self.db.query(Group).filter(Group.share_code == share_code.upper()).first()
        )
