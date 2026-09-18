import threading
import time

import pytest

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
        assert first["serverGeneration"] == second["serverGeneration"]

    def test_register_rejects_overlong_group_id(self, client):
        # Mirrors groups.id String(36): reject at the API boundary, not as a
        # MariaDB strict-mode 500 during commit.
        r = client.post("/api/v1/groups/register", json={"groupId": "x" * 37})
        assert r.status_code == 422

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
        assert body["serverGeneration"]

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
        assert (
            client.post("/api/v1/groups/g1/ops", json={"ops": ops}).json()["accepted"]
            == 1
        )

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
        seqs = [
            o["opId"] for o in client.get("/api/v1/groups/g1/ops?since=0").json()["ops"]
        ]
        assert seqs == ["o1", "o2"]

    def test_two_devices_pull_union(self, client):
        register(client)
        client.post(
            "/api/v1/groups/g1/ops", json={"ops": [make_op("a1", "g1", 1, actor="A")]}
        )
        client.post(
            "/api/v1/groups/g1/ops", json={"ops": [make_op("b1", "g1", 1, actor="B")]}
        )
        ids = {
            o["opId"] for o in client.get("/api/v1/groups/g1/ops?since=0").json()["ops"]
        }
        assert ids == {"a1", "b1"}

    def test_empty_push_is_ok(self, client):
        register(client)
        assert (
            client.post("/api/v1/groups/g1/ops", json={"ops": []}).json()["accepted"]
            == 0
        )

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


class TestSyncEndpoint:
    """POST /groups/{id}/sync — push + pull in one round trip."""

    def test_sync_push_and_pull_in_one_roundtrip(self, client):
        register(client)
        ops = [make_op("o1", "g1", 1), make_op("o2", "g1", 2)]
        r = client.post("/api/v1/groups/g1/sync", json={"ops": ops, "since": 0})
        assert r.status_code == 200
        body = r.json()
        # The device's own freshly-pushed ops are in the SAME response: no
        # second request needed to learn their seq.
        assert body["accepted"] == 2
        assert [o["opId"] for o in body["ops"]] == ["o1", "o2"]
        assert body["cursor"] >= 2
        assert body["serverGeneration"]

    def test_sync_empty_ops_is_a_pull(self, client):
        register(client)
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 1)]})
        body = client.post(
            "/api/v1/groups/g1/sync", json={"ops": [], "since": 0}
        ).json()
        assert body["accepted"] == 0
        assert [o["opId"] for o in body["ops"]] == ["o1"]

    def test_sync_idempotent_repush(self, client):
        register(client)
        payload = {"ops": [make_op("o1", "g1", 1)], "since": 0}
        first = client.post("/api/v1/groups/g1/sync", json=payload).json()
        # Crash-before-acked scenario: same request replayed.
        second = client.post("/api/v1/groups/g1/sync", json=payload).json()
        assert first["accepted"] == 1
        assert second["accepted"] == 0  # dedup by opId
        assert [o["opId"] for o in second["ops"]] == ["o1"]  # no duplicate rows
        assert second["cursor"] == first["cursor"]

    def test_sync_sees_peer_ops_since_cursor(self, client):
        register(client)
        # A's op lands first (seq 1); B already has it (cursor=1).
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("a1", "g1", 1, actor="A")]})
        # A pushes a second op (seq 2) while B has none pending... then B pushes
        # b1 with its cursor: B gets A's new op AND its own op in one response.
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("a2", "g1", 2, actor="A")]})
        b = client.post(
            "/api/v1/groups/g1/sync",
            json={"ops": [make_op("b1", "g1", 3, actor="B")], "since": 1},
        ).json()
        assert b["accepted"] == 1
        assert {o["opId"] for o in b["ops"]} == {"a2", "b1"}  # a1 excluded (<= since)
        assert b["cursor"] >= 3

    def test_sync_unregistered_group_404(self, client):
        r = client.post(
            "/api/v1/groups/does-not-exist/sync", json={"ops": [], "since": 0}
        )
        assert r.status_code == 404

    def test_sync_ahead_of_server_returns_real_max(self, client):
        register(client)
        client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 1)]})
        body = client.post(
            "/api/v1/groups/g1/sync", json={"ops": [], "since": 999}
        ).json()
        # Same self-heal signal as pull: empty window + REAL max cursor.
        assert body["ops"] == []
        assert body["cursor"] < 999

    def test_sync_reseed_flag_accepted(self, client):
        register(client)
        body = client.post(
            "/api/v1/groups/g1/sync",
            json={"ops": [make_op("r1", "g1", 1)], "since": 0, "reseed": True},
        ).json()
        assert body["accepted"] == 1


class TestEventsEndpoint:
    """GET /groups/{id}/events — SSE wake-ups.

    The stream tests run against a real uvicorn subprocess, NOT the TestClient:
    this starlette version's TestClient runs the app via a blocking portal
    call and buffers the whole response until it completes, so an infinite
    SSE stream never delivers headers through it. A live server is also the
    only environment where the cross-thread publish (request threadpool ->
    SSE loop via call_soon_threadsafe) is actually exercised.
    """

    @pytest.fixture()
    def sse_server(self):
        import os
        import socket
        import subprocess
        import sys

        import httpx

        db_path = f"/tmp/ardoise-sse-test-{os.getpid()}.db"
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(db_path + suffix):
                os.remove(db_path + suffix)
        # The app never auto-creates tables (production runs alembic, the
        # TestClient fixture does create_all in-memory) — do it here so the
        # fresh file is usable the moment uvicorn starts.
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        import app.models  # noqa: F401  (registers the models on Base)
        from app.core.database import Base

        engine = create_engine(f"sqlite:///{db_path}")
        Base.metadata.create_all(bind=engine)
        engine.dispose()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        env = dict(os.environ)
        env.update(
            {
                "API_KEY": "ssekey",
                "DATABASE_URL": f"sqlite:///{db_path}",
                "DB_HOST": "x",
                "DB_USER": "x",
                "DB_PASSWORD": "x",
            }
        )
        cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        proc = subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn", "app.main:app",
                "--port", str(port), "--log-level", "warning",
            ],
            env=env,
            cwd=cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{port}"
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                httpx.get(base + "/health", timeout=0.5)
                break
            except Exception:
                time.sleep(0.1)
        else:
            proc.terminate()
            raise RuntimeError("uvicorn did not start")
        try:
            yield base, "ssekey"
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                # Uvicorn's graceful shutdown waits for in-flight requests to
                # finish — an open SSE stream never does. Force kill.
                proc.kill()
                proc.wait(timeout=5)
            for suffix in ("", "-wal", "-shm"):
                if os.path.exists(db_path + suffix):
                    os.remove(db_path + suffix)

    def test_events_content_type_first_line_and_wake(self, sse_server):
        import json

        import httpx

        base, key = sse_server
        h = {"X-API-Key": key}
        httpx.post(
            base + "/api/v1/groups/register",
            json={"groupId": "g1"}, headers=h, timeout=5,
        )
        lines: list[str] = []
        got_event = threading.Event()

        def reader():
            with httpx.stream(
                "GET", base + "/api/v1/groups/g1/events", headers=h, timeout=None
            ) as r:
                assert r.status_code == 200
                assert r.headers["content-type"].startswith("text/event-stream")
                assert r.headers["cache-control"] == "no-cache"
                for line in r.iter_lines():
                    lines.append(line)
                    if line.startswith("data:"):
                        got_event.set()
                        break

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        # Push with fresh opIds until the subscription has registered and the
        # wake arrives (avoids a race between subscribe and the first push;
        # fresh opIds keep each attempt a genuinely new op, so dedup cannot
        # swallow the wake).
        n = 0
        deadline = time.time() + 15
        while not got_event.is_set() and time.time() < deadline:
            n += 1
            httpx.post(
                base + "/api/v1/groups/g1/ops",
                json={"ops": [make_op(f"wake-{n}", "g1", n)]},
                headers=h, timeout=5,
            )
            time.sleep(0.1)
        assert got_event.is_set(), f"no SSE wake-up received; lines so far: {lines}"
        assert ": connected" in lines
        assert json.loads(next(l for l in lines if l.startswith("data:"))[5:])["seq"] >= 1

    def test_events_no_wake_on_dedup_or_reseed(self, sse_server):
        import httpx

        base, key = sse_server
        h = {"X-API-Key": key}
        gid = "gd"
        httpx.post(
            base + "/api/v1/groups/register",
            json={"groupId": gid}, headers=h, timeout=5,
        )
        lines: list[str] = []
        first_event = threading.Event()

        def reader():
            with httpx.stream(
                "GET", f"{base}/api/v1/groups/{gid}/events", headers=h, timeout=None
            ) as r:
                for line in r.iter_lines():
                    lines.append(line)
                    if line.startswith("data:") and not first_event.is_set():
                        first_event.set()

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        n = 0
        deadline = time.time() + 15
        while not first_event.is_set() and time.time() < deadline:
            n += 1
            httpx.post(
                f"{base}/api/v1/groups/{gid}/ops",
                json={"ops": [make_op(f"d-{n}", gid, n)]},
                headers=h, timeout=5,
            )
            time.sleep(0.1)
        assert first_event.is_set()
        # Dedup push (same opId) and reseed push create no new rows: no wake.
        op = make_op(f"d-{n}", gid, n)
        httpx.post(f"{base}/api/v1/groups/{gid}/ops", json={"ops": [op]}, headers=h, timeout=5)
        httpx.post(
            f"{base}/api/v1/groups/{gid}/ops",
            json={"ops": [op], "reseed": True}, headers=h, timeout=5,
        )
        time.sleep(1.0)
        assert len([l for l in lines if l.startswith("data:")]) == 1
        t.join(timeout=2)

    def test_events_unknown_group_404(self, client):
        assert client.get("/api/v1/groups/does-not-exist/events").status_code == 404

    def test_events_requires_api_key(self, sse_server):
        import httpx

        base, key = sse_server
        r = httpx.get(base + "/api/v1/groups/g1/events", timeout=5)
        assert r.status_code == 401
        r = httpx.get(
            base + "/api/v1/groups/g1/events", headers={"X-API-Key": "nope"}, timeout=5
        )
        assert r.status_code == 401


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
