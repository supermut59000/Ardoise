"""Web Push: subscription endpoints, notification fan-out, message builder."""
import pytest

import app.services.push_service as push_service
from app.core.config import settings
from app.models.push_subscription import PushSubscription
from app.schemas.sync import OperationWire
from tests.conftest import make_op


# A throwaway raw base64url P-256 private key would need cryptography to mint;
# for these tests we only need push_enabled() to flip, and we monkeypatch the
# actual webpush sender, so any non-empty string does.
FAKE_VAPID = "fake-key-for-tests"


@pytest.fixture
def push_on(monkeypatch):
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", FAKE_VAPID)


def subscription_body(endpoint="https://push.example/s1", device="devA", groups=("g1",)):
    return {
        "endpoint": endpoint,
        "keys": {"p256dh": "pk", "auth": "ak"},
        "deviceId": device,
        "groupIds": list(groups),
    }


class TestSubscribeEndpoints:
    def test_disabled_instance_answers_503(self, client):
        assert client.get("/api/v1/push/vapid-public-key").status_code == 503
        assert client.post("/api/v1/push/subscribe", json=subscription_body()).status_code == 503

    def test_subscribe_upserts_by_endpoint(self, client, push_on):
        r = client.post("/api/v1/push/subscribe", json=subscription_body(groups=("g1",)))
        assert r.status_code == 200
        # Same endpoint, updated group list: still one row, groups replaced.
        r = client.post("/api/v1/push/subscribe", json=subscription_body(groups=("g1", "g2")))
        assert r.status_code == 200

    def test_unsubscribe_is_idempotent(self, client, push_on):
        client.post("/api/v1/push/subscribe", json=subscription_body())
        assert client.post("/api/v1/push/unsubscribe", json={"endpoint": "https://push.example/s1"}).status_code == 200
        # unknown endpoint: still ok
        assert client.post("/api/v1/push/unsubscribe", json={"endpoint": "https://push.example/s1"}).status_code == 200


def wire(op_id="o1", entity="expense", action="create", payload=None, actor="devA"):
    return OperationWire(
        **make_op(op_id, "g1", 1, entity=entity, action=action, actor=actor,
                  payload=payload if payload is not None else {"amountCents": 100})
    )


class TestBuildMessage:
    def test_single_expense_create(self):
        title, body = push_service.build_message(
            [wire(payload={"description": "Courses", "amountCents": 2450})]
        )
        assert title == "Nouvelle depense"
        assert body == "Courses : 24,50 EUR"

    def test_single_settlement(self):
        title, body = push_service.build_message(
            [wire(entity="settlement", payload={"amountCents": 1000})]
        )
        assert title == "Remboursement enregistre"
        assert body == "10,00 EUR"

    def test_batch_collapses_to_count(self):
        title, body = push_service.build_message([wire("a"), wire("b"), wire("c")])
        assert title == "Ardoise"
        assert body == "3 modifications dans votre groupe"


class TestNotifyFanOut:
    def _seed_subscriptions(self, client, push_on):
        client.post("/api/v1/push/subscribe", json=subscription_body("https://push.example/author", "devA", ("g1",)))
        client.post("/api/v1/push/subscribe", json=subscription_body("https://push.example/friend", "devB", ("g1",)))
        client.post("/api/v1/push/subscribe", json=subscription_body("https://push.example/other-group", "devC", ("g9",)))

    def test_notifies_followers_but_never_the_author(self, client, push_on, monkeypatch):
        self._seed_subscriptions(client, push_on)
        sent = []
        monkeypatch.setattr(push_service, "_send", lambda sub, payload: sent.append(sub.endpoint) or None)

        # Reach into the test session the way the endpoint's task would.
        from app.core.database import get_db
        from app.main import app
        db = next(iter(app.dependency_overrides[get_db]()))
        n = push_service.notify_group(db, "g1", "devA", [wire()])
        assert n == 1
        assert sent == ["https://push.example/friend"]  # author and other-group skipped

    def test_dead_subscription_is_pruned(self, client, push_on, monkeypatch):
        self._seed_subscriptions(client, push_on)
        monkeypatch.setattr(push_service, "_send", lambda sub, payload: 410)

        from app.core.database import get_db
        from app.main import app
        db = next(iter(app.dependency_overrides[get_db]()))
        push_service.notify_group(db, "g1", "devA", [wire()])
        remaining = {s.endpoint for s in db.query(PushSubscription).all()}
        assert remaining == {"https://push.example/author", "https://push.example/other-group"}

    def test_push_endpoint_schedules_notification(self, client, push_on, monkeypatch):
        """End to end through the API: a sync push from devA notifies devB."""
        self._seed_subscriptions(client, push_on)
        sent = []
        monkeypatch.setattr(push_service, "_send", lambda sub, payload: sent.append((sub.endpoint, payload)) or None)
        # notify_task opens its own SessionLocal; point it at the test session factory.
        from app.core.database import get_db
        from app.main import app
        override = app.dependency_overrides[get_db]
        monkeypatch.setattr(
            "app.core.database.SessionLocal", lambda: next(iter(override()))
        )

        client.post("/api/v1/groups/register", json={"groupId": "g1"})
        r = client.post(
            "/api/v1/groups/g1/ops",
            json={"ops": [make_op("o1", "g1", 1, actor="devA",
                                  payload={"description": "Pizza", "amountCents": 1800})]},
        )
        assert r.status_code == 200
        # TestClient runs background tasks before returning.
        assert [e for e, _ in sent] == ["https://push.example/friend"]
        assert "Pizza" in sent[0][1]

    def test_reseed_sized_batch_stays_silent(self, client, push_on, monkeypatch):
        self._seed_subscriptions(client, push_on)
        sent = []
        monkeypatch.setattr(push_service, "_send", lambda sub, payload: sent.append(sub.endpoint) or None)
        client.post("/api/v1/groups/register", json={"groupId": "g1"})
        ops = [make_op(f"op{i}", "g1", i + 1, actor="devA") for i in range(push_service.NOTIFY_MAX_BATCH + 1)]
        assert client.post("/api/v1/groups/g1/ops", json={"ops": ops}).status_code == 200
        assert sent == []  # heal/catch-up batches never spam the group
