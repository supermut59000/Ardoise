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


def subscription_body(
    endpoint="https://push.example/s1", device="devA", groups=("g1",)
):
    return {
        "endpoint": endpoint,
        "keys": {"p256dh": "pk", "auth": "ak"},
        "deviceId": device,
        "groupIds": list(groups),
    }


class TestSubscribeEndpoints:
    def test_disabled_instance_answers_503(self, client):
        assert client.get("/api/v1/push/vapid-public-key").status_code == 503
        assert (
            client.post("/api/v1/push/subscribe", json=subscription_body()).status_code
            == 503
        )

    def test_subscribe_upserts_by_endpoint(self, client, push_on):
        r = client.post(
            "/api/v1/push/subscribe", json=subscription_body(groups=("g1",))
        )
        assert r.status_code == 200
        # Same endpoint, updated group list: still one row, groups replaced.
        r = client.post(
            "/api/v1/push/subscribe", json=subscription_body(groups=("g1", "g2"))
        )
        assert r.status_code == 200

    def test_unsubscribe_is_idempotent(self, client, push_on):
        client.post("/api/v1/push/subscribe", json=subscription_body())
        assert (
            client.post(
                "/api/v1/push/unsubscribe", json={"endpoint": "https://push.example/s1"}
            ).status_code
            == 200
        )
        # unknown endpoint: still ok
        assert (
            client.post(
                "/api/v1/push/unsubscribe", json={"endpoint": "https://push.example/s1"}
            ).status_code
            == 200
        )


def wire(op_id="o1", entity="expense", action="create", payload=None, actor="devA"):
    return OperationWire(
        **make_op(
            op_id,
            "g1",
            1,
            entity=entity,
            action=action,
            actor=actor,
            payload=payload if payload is not None else {"amountCents": 100},
        )
    )


NO_LOOKUP = lambda entity, entity_id, field: None  # noqa: E731


class TestBuildBody:
    def test_single_expense_create(self):
        body = push_service.build_body(
            [wire(payload={"description": "Courses", "amountCents": 2450})], NO_LOOKUP
        )
        assert body == "Nouvelle depense : Courses (24,50 EUR)"

    def test_expense_delete_names_the_expense_via_lookup(self):
        """A delete op has an empty payload; the description must come from the
        expense's earlier ops so the user knows WHAT was deleted."""
        lookup = lambda entity, entity_id, field: (  # noqa: E731
            "Pizza" if (entity, field) == ("expense", "description") else None
        )
        body = push_service.build_body([wire(action="delete", payload={})], lookup)
        assert body == "Depense supprimee : Pizza"

    def test_expense_delete_degrades_without_history(self):
        body = push_service.build_body([wire(action="delete", payload={})], NO_LOOKUP)
        assert body == "Depense supprimee"

    def test_single_settlement(self):
        body = push_service.build_body(
            [wire(entity="settlement", payload={"amountCents": 1000})], NO_LOOKUP
        )
        assert body == "Remboursement enregistre : 10,00 EUR"

    def test_member_removed_names_the_member(self):
        lookup = lambda entity, entity_id, field: (  # noqa: E731
            "Sarah" if (entity, field) == ("member", "name") else None
        )
        body = push_service.build_body(
            [wire(entity="member", action="delete", payload={})], lookup
        )
        assert body == "Participant retire : Sarah"

    def test_batch_collapses_to_count(self):
        body = push_service.build_body([wire("a"), wire("b"), wire("c")], NO_LOOKUP)
        assert body == "3 modifications"


class TestNotifyFanOut:
    def test_lookup_ties_use_op_id_like_the_client_fold(self, client):
        client.post("/api/v1/groups/register", json={"groupId": "g1"})
        # zzz wins the client fold at equal Lamport even though it arrives first.
        client.post(
            "/api/v1/groups/g1/ops",
            json={
                "ops": [
                    make_op(
                        "zzz",
                        "g1",
                        5,
                        entity="group",
                        entityId="g1",
                        action="update",
                        payload={"name": "Paris"},
                    ),
                    make_op(
                        "aaa",
                        "g1",
                        5,
                        entity="group",
                        entityId="g1",
                        action="update",
                        payload={"name": "Lyon"},
                    ),
                ]
            },
        )
        from app.core.database import get_db
        from app.main import app

        db = next(iter(app.dependency_overrides[get_db]()))
        assert push_service._latest_payload_field(db, "g1", "group", "name") == "Paris"

    def _seed_subscriptions(self, client, push_on):
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/author", "devA", ("g1",)),
        )
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/friend", "devB", ("g1",)),
        )
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/other-group", "devC", ("g9",)),
        )

    def test_notifies_followers_but_never_the_author(
        self, client, push_on, monkeypatch
    ):
        self._seed_subscriptions(client, push_on)
        sent = []
        monkeypatch.setattr(
            push_service,
            "_send",
            lambda sub, payload: sent.append(sub.endpoint) or None,
        )

        # Reach into the test session the way the endpoint's task would.
        from app.core.database import get_db
        from app.main import app

        db = next(iter(app.dependency_overrides[get_db]()))
        n = push_service.notify_group(db, "g1", {"devA"}, [wire()])
        assert n == 1
        assert sent == ["https://push.example/friend"]  # author and other-group skipped

    def test_mixed_actor_batch_excludes_every_author(
        self, client, push_on, monkeypatch
    ):
        """A self-heal re-push can carry ops from several devices: excluding only
        the first author would let the healing device notify itself. Every
        author's device must be skipped; a non-author follower still gets it."""
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/devA", "devA", ("g1",)),
        )
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/devB", "devB", ("g1",)),
        )
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/devC", "devC", ("g1",)),
        )
        sent = []
        monkeypatch.setattr(
            push_service,
            "_send",
            lambda sub, payload: sent.append(sub.endpoint) or None,
        )

        from app.core.database import get_db
        from app.main import app

        db = next(iter(app.dependency_overrides[get_db]()))
        n = push_service.notify_group(
            db,
            "g1",
            {"devA", "devB"},
            [wire(op_id="a1", actor="devA"), wire(op_id="b1", actor="devB")],
        )
        assert n == 1
        assert sent == ["https://push.example/devC"]  # both authors excluded

    def test_dead_subscription_is_pruned(self, client, push_on, monkeypatch):
        self._seed_subscriptions(client, push_on)
        monkeypatch.setattr(push_service, "_send", lambda sub, payload: 410)

        from app.core.database import get_db
        from app.main import app

        db = next(iter(app.dependency_overrides[get_db]()))
        push_service.notify_group(db, "g1", {"devA"}, [wire()])
        remaining = {s.endpoint for s in db.query(PushSubscription).all()}
        assert remaining == {
            "https://push.example/author",
            "https://push.example/other-group",
        }

    def test_push_endpoint_schedules_notification(self, client, push_on, monkeypatch):
        """End to end through the API: a sync push from devA notifies devB,
        with the group's NAME as the title (resolved from the op log)."""
        import json

        self._seed_subscriptions(client, push_on)
        sent = []
        monkeypatch.setattr(
            push_service,
            "_send",
            lambda sub, payload: sent.append((sub.endpoint, payload)) or None,
        )
        # notify_task opens its own SessionLocal; point it at the test session factory.
        from app.core.database import get_db
        from app.main import app

        override = app.dependency_overrides[get_db]
        monkeypatch.setattr(
            "app.core.database.SessionLocal", lambda: next(iter(override()))
        )

        client.post("/api/v1/groups/register", json={"groupId": "g1"})
        # The group's create op carries its name; later ops resolve it for the title.
        client.post(
            "/api/v1/groups/g1/ops",
            json={
                "ops": [
                    make_op(
                        "g-create",
                        "g1",
                        1,
                        entity="group",
                        entityId="g1",
                        payload={"name": "Week-end Bretagne"},
                    )
                ]
            },
        )
        sent.clear()
        r = client.post(
            "/api/v1/groups/g1/ops",
            json={
                "ops": [
                    make_op(
                        "o1",
                        "g1",
                        2,
                        actor="devA",
                        payload={"description": "Pizza", "amountCents": 1800},
                    )
                ]
            },
        )
        assert r.status_code == 200
        # TestClient runs background tasks before returning.
        assert [e for e, _ in sent] == ["https://push.example/friend"]
        message = json.loads(sent[0][1])
        assert message["title"] == "Week-end Bretagne"
        assert message["body"] == "Nouvelle depense : Pizza (18,00 EUR)"

        # Deleting that expense names it too (its delete op has an empty payload).
        sent.clear()
        client.post(
            "/api/v1/groups/g1/ops",
            json={
                "ops": [
                    make_op(
                        "o2",
                        "g1",
                        3,
                        actor="devA",
                        action="delete",
                        entityId="e1",
                        payload={},
                    )
                ]
            },
        )
        message = json.loads(sent[0][1])
        assert message["title"] == "Week-end Bretagne"
        assert message["body"] == "Depense supprimee : Pizza"

    def test_reseed_sized_batch_stays_silent(self, client, push_on, monkeypatch):
        self._seed_subscriptions(client, push_on)
        sent = []
        monkeypatch.setattr(
            push_service,
            "_send",
            lambda sub, payload: sent.append(sub.endpoint) or None,
        )
        client.post("/api/v1/groups/register", json={"groupId": "g1"})
        ops = [
            make_op(f"op{i}", "g1", i + 1, actor="devA")
            for i in range(push_service.NOTIFY_MAX_BATCH + 1)
        ]
        assert (
            client.post("/api/v1/groups/g1/ops", json={"ops": ops}).status_code == 200
        )
        assert sent == []  # heal/catch-up batches never spam the group

    def test_reseed_flag_keeps_small_batches_silent(self, client, push_on, monkeypatch):
        """Without the flag, a small batch is live activity and notifies; with
        it (a client re-pushing its whole log after a wipe), even 1 op is a
        reseed and must not ring anyone."""
        self._seed_subscriptions(client, push_on)
        sent = []
        monkeypatch.setattr(
            push_service,
            "_send",
            lambda sub, payload: sent.append(sub.endpoint) or None,
        )
        # notify_task opens its own SessionLocal; point it at the test session.
        from app.core.database import get_db
        from app.main import app

        override = app.dependency_overrides[get_db]
        monkeypatch.setattr(
            "app.core.database.SessionLocal", lambda: next(iter(override()))
        )
        client.post("/api/v1/groups/register", json={"groupId": "g1"})

        # No flag: same-size live push notifies the follower.
        client.post(
            "/api/v1/groups/g1/ops",
            json={
                "ops": [
                    make_op(
                        "o1",
                        "g1",
                        1,
                        actor="devA",
                        payload={"description": "Pizza", "amountCents": 1800},
                    )
                ]
            },
        )
        assert sent == ["https://push.example/friend"]

        # Flag set: identical push is a reseed, stays silent.
        sent.clear()
        r = client.post(
            "/api/v1/groups/g1/ops",
            json={
                "ops": [
                    make_op(
                        "o2",
                        "g1",
                        2,
                        actor="devA",
                        payload={"description": "Pizza", "amountCents": 1800},
                    )
                ],
                "reseed": True,
            },
        )
        assert r.status_code == 200
        assert sent == []

    def test_push_batch_mixed_actors_excludes_every_author_end_to_end(
        self, client, push_on, monkeypatch
    ):
        """End to end: a batch carrying ops from two devices excludes both, and
        the endpoint's exclusion set is built from all accepted actors."""
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/devA", "devA", ("g1",)),
        )
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/devB", "devB", ("g1",)),
        )
        client.post(
            "/api/v1/push/subscribe",
            json=subscription_body("https://push.example/devC", "devC", ("g1",)),
        )
        sent = []
        monkeypatch.setattr(
            push_service,
            "_send",
            lambda sub, payload: sent.append(sub.endpoint) or None,
        )
        from app.core.database import get_db
        from app.main import app

        override = app.dependency_overrides[get_db]
        monkeypatch.setattr(
            "app.core.database.SessionLocal", lambda: next(iter(override()))
        )
        client.post("/api/v1/groups/register", json={"groupId": "g1"})

        r = client.post(
            "/api/v1/groups/g1/ops",
            json={
                "ops": [
                    make_op(
                        "a1",
                        "g1",
                        1,
                        actor="devA",
                        payload={"description": "Pizza", "amountCents": 1800},
                    ),
                    make_op(
                        "b1",
                        "g1",
                        2,
                        actor="devB",
                        payload={"description": "Courses", "amountCents": 500},
                    ),
                ]
            },
        )
        assert r.status_code == 200
        assert sent == ["https://push.example/devC"]
