import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register models on Base.metadata)
from app.core.config import settings
from app.core.database import Base, get_db
from app.main import app


@pytest.fixture(scope="session", autouse=True)
def _dev_defaults():
    # `settings` is a module-level singleton built from the container's env at
    # import time; on a real instance that env carries API_KEY/VAPID keys, which
    # would break the "disabled by default" tests. Pin dev defaults once so the
    # suite is hermetic everywhere (tests that need other values set them
    # themselves and restore them).
    settings.API_KEY = ""
    settings.VAPID_PRIVATE_KEY = ""
    yield


@pytest.fixture
def client():
    # In-memory SQLite shared across the connection pool for the test's lifetime.
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def make_op(op_id: str, group_id: str, lamport: int, **over):
    """A minimal valid operation in wire (camelCase) shape."""
    op = {
        "opId": op_id,
        "groupId": group_id,
        "entity": "expense",
        "entityId": "e1",
        "action": "create",
        "payload": {"amountCents": 100},
        "actor": "devA",
        "lamport": lamport,
        "createdAt": 1_700_000_000_000 + lamport,
    }
    op.update(over)
    return op
