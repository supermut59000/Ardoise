from tests.conftest import make_op


def register(client, group_id="g1"):
    r = client.post("/api/v1/groups/register", json={"groupId": group_id})
    assert r.status_code == 200
    return r.json()


class TestGroups:
    def test_register_returns_share_code(self, client):
        body = register(client)
        assert body["groupId"] == "g1"
        assert len(body["shareCode"]) >= 6

    def test_register_is_idempotent(self, client):
        first = register(client)
        second = register(client)
        assert first["shareCode"] == second["shareCode"]

    def test_resolve_share_code(self, client):
        code = register(client)["shareCode"]
        r = client.get(f"/api/v1/groups/resolve/{code}")
        assert r.status_code == 200
        assert r.json()["groupId"] == "g1"

    def test_resolve_unknown_code_404(self, client):
        assert client.get("/api/v1/groups/resolve/NOPE1234").status_code == 404

    def test_get_unregistered_group_404(self, client):
        assert client.get("/api/v1/groups/does-not-exist").status_code == 404


class TestPushPull:
    def test_push_requires_registered_group(self, client):
        r = client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 1)]})
        assert r.status_code == 404

    def test_push_then_pull_roundtrip(self, client):
        register(client)
        ops = [make_op("o1", "g1", 1), make_op("o2", "g1", 2)]
        r = client.post("/api/v1/groups/g1/ops", json={"ops": ops})
        assert r.status_code == 200
        assert r.json()["accepted"] == 2

        r = client.get("/api/v1/groups/g1/ops?since=0")
        body = r.json()
        assert len(body["ops"]) == 2
        # wire format preserved (camelCase, payload intact)
        assert body["ops"][0]["opId"] == "o1"
        assert body["ops"][0]["payload"] == {"amountCents": 100}
        assert body["cursor"] >= 2

    def test_push_is_idempotent(self, client):
        register(client)
        ops = [make_op("o1", "g1", 1)]
        first = client.post("/api/v1/groups/g1/ops", json={"ops": ops}).json()
        second = client.post("/api/v1/groups/g1/ops", json={"ops": ops}).json()
        assert first["accepted"] == 1
        assert second["accepted"] == 0  # duplicate ignored
        assert len(client.get("/api/v1/groups/g1/ops?since=0").json()["ops"]) == 1

    def test_duplicate_within_single_request_counted_once(self, client):
        register(client)
        ops = [make_op("dup", "g1", 1), make_op("dup", "g1", 1)]
        assert client.post("/api/v1/groups/g1/ops", json={"ops": ops}).json()["accepted"] == 1

    def test_pull_since_cursor_returns_only_newer(self, client):
        register(client)
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 1)]})
        cursor = client.get("/api/v1/groups/g1/ops?since=0").json()["cursor"]
        # push a second op, pull since the first cursor
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o2", "g1", 2)]})
        body = client.get(f"/api/v1/groups/g1/ops?since={cursor}").json()
        assert [o["opId"] for o in body["ops"]] == ["o2"]

    def test_pull_returns_ops_in_seq_order(self, client):
        register(client)
        # push out of lamport order; server orders by its own seq (insertion)
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 5)]})
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o2", "g1", 2)]})
        seqs = [o["opId"] for o in client.get("/api/v1/groups/g1/ops?since=0").json()["ops"]]
        assert seqs == ["o1", "o2"]

    def test_two_devices_pull_union(self, client):
        register(client)
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("a1", "g1", 1, actor="A")]})
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("b1", "g1", 1, actor="B")]})
        ids = {o["opId"] for o in client.get("/api/v1/groups/g1/ops?since=0").json()["ops"]}
        assert ids == {"a1", "b1"}

    def test_empty_push_is_ok(self, client):
        register(client)
        assert client.post("/api/v1/groups/g1/ops", json={"ops": []}).json()["accepted"] == 0

    def test_pull_ahead_of_server_returns_real_max(self, client):
        """
        Rewind detection (self-heal after a DB restore from an older backup):
        a client whose cursor is AHEAD of the server must get the server's real
        max cursor back, not its own `since` echoed, so it can notice the rewind
        and re-seed. The old behavior (echoing `since`) made the divergence
        silent and permanent.
        """
        register(client)
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 1)]})
        max_cursor = client.get("/api/v1/groups/g1/ops?since=0").json()["cursor"]

        body = client.get(f"/api/v1/groups/g1/ops?since={max_cursor + 100}").json()
        assert body["ops"] == []
        assert body["cursor"] == max_cursor  # real max, NOT since echoed back


class TestWireValidation:
    """
    A malformed op must be a clean 422, never a MariaDB error 500: the columns
    are String(36)/String(64) and strict mode would reject over-length values
    only at commit time, turning one bad op into an opaque, endlessly-retried
    server error.
    """

    def test_push_rejects_unknown_entity(self, client):
        register(client)
        bad = make_op("o1", "g1", 1, entity="vehicle")
        r = client.post("/api/v1/groups/g1/ops", json={"ops": [bad]})
        assert r.status_code == 422

    def test_push_rejects_unknown_action(self, client):
        register(client)
        bad = make_op("o1", "g1", 1, action="upsert")
        r = client.post("/api/v1/groups/g1/ops", json={"ops": [bad]})
        assert r.status_code == 422

    def test_push_rejects_overlong_op_id(self, client):
        register(client)
        bad = make_op("x" * 37, "g1", 1)
        r = client.post("/api/v1/groups/g1/ops", json={"ops": [bad]})
        assert r.status_code == 422

    def test_push_rejects_overlong_actor(self, client):
        register(client)
        bad = make_op("o1", "g1", 1, actor="a" * 65)
        r = client.post("/api/v1/groups/g1/ops", json={"ops": [bad]})
        assert r.status_code == 422

    def test_valid_op_still_accepted(self, client):
        # The constraints must not reject what the real client sends (36-char
        # UUID ids, the four entities, the three actions).
        register(client)
        ok = make_op("123e4567-e89b-42d3-a456-426614174000", "g1", 1)
        r = client.post("/api/v1/groups/g1/ops", json={"ops": [ok]})
        assert r.status_code == 200
        assert r.json()["accepted"] == 1


class TestHealth:
    def test_health_returns_503_when_db_unreachable(self, client, monkeypatch):
        """Docker's healthcheck only reads the status code, so a DB outage must
        be a 503, never a 200 with an 'unhealthy' body."""
        import app.main as main_module

        def broken_session():
            raise RuntimeError("db down")

        monkeypatch.setattr(main_module, "SessionLocal", broken_session)
        r = client.get("/health")
        assert r.status_code == 503
        assert r.json()["status"] == "unhealthy"
