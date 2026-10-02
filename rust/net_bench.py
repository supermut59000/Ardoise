#!/usr/bin/env python3
"""Network-contract A/B bench: POST /sync (one round trip) + SSE /events wake.

Both backends (Python+SQLite, Rust+SQLite), loopback, median of 7 (house
method). Measures the 2026-09-18 contract end to end:
  - /sync idle / 1 op / 3 ops / 500 ops / 10k catch-up (20 x 500)
  - full-group fresh-join pull (raw size, gzip-5 size); note: after the
    catch-up runs the group holds ~53.5k ops, so "join" means a 9.4 MB pull
  - OLD contract cost: push(1 op) + pull = 2 round trips
  - SSE wake latency: push completes -> wake frame received on the stream
  - E2E "peer up to date": wake latency + one /sync
Writes /tmp/net-bench.json, prints the A/B table. Exit 0.
"""
import http.client as httpc, gzip, json, os, subprocess, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parity_check import free_port, start, register, PYV, RUST, ROOT, KEY
from parity_check import http as req  # noqa: E402

# DB_RUST is env-overridable so disk-wear runs can put the DB on a real
# filesystem (tmpfs would mask all block I/O). RUST binary: swap on disk.
DB_RUST, DB_PY = os.environ.get("DB_RUST", "/tmp/netb-rust.db"), "/tmp/netb-py.db"
GID = "g-netb"
N_SEED = 10_000
REPS, REPS_SLOW = 7, 3


def setup():
    # Remove the DB and its -wal/-shm sidecars: a stale sidecar plus an
    # orphaned server yields sqlite "disk I/O error" on the next run.
    for d in (DB_RUST, DB_PY):
        for suffix in ("", "-wal", "-shm"):
            p = d + suffix
            if os.path.exists(p):
                os.remove(p)
    p_rust, p_py = free_port(), free_port()
    base_rust, base_py = f"http://127.0.0.1:{p_rust}", f"http://127.0.0.1:{p_py}"
    env_rust = dict(os.environ, DATA_FILE=DB_RUST, API_KEY=KEY, PORT=str(p_rust))
    env_py = dict(os.environ, DATABASE_URL=f"sqlite:///{DB_PY}", API_KEY=KEY,
                  DB_HOST="x", DB_USER="x", DB_PASSWORD="x")
    # The app never auto-creates tables; do it once for the Python side.
    subprocess.run(
        [PYV, "-c",
         f"import os;os.environ['DATABASE_URL']='sqlite:////{DB_PY}';"
         "import app.models;"
         "from app.core.database import Base, engine;"
         "Base.metadata.create_all(engine)"],
        cwd=f"{ROOT}/backend",
        env=dict(os.environ, DB_HOST="x", DB_USER="x", DB_PASSWORD="x"),
        check=True,
    )
    py = start(PYV, ["-m", "uvicorn", "app.main:app", "--port", str(p_py)],
               env_py, "/tmp/netb-py.log", cwd=f"{ROOT}/backend")
    ru = start(RUST, [], env_rust, "/tmp/netb-rust.log")
    return base_py, base_rust, py, ru


def wait_up(base, tries=50):
    for _ in range(tries):
        try:
            urllib.request.urlopen(base + "/api/v1/system/ping", timeout=1).read()
            return
        except Exception:
            time.sleep(0.2)
    raise SystemExit(f"server not up: {base}")


def op(i):
    return {"opId": f"nb-{i}", "groupId": GID, "entity": "expense",
            "entityId": f"e-{i}", "action": "create",
            "payload": {"amount": i % 1000 + 1}, "actor": "bench",
            "lamport": i + 1, "createdAt": 1700000000 + i}


def median(xs):
    return sorted(xs)[len(xs) // 2]


def sync(base, cursor, n_ops, i0):
    """One timed /sync pushing n_ops fresh ops; returns (ms, new_cursor)."""
    t0 = time.monotonic()
    r = req("POST", f"{base}/api/v1/groups/{GID}/sync",
             {"ops": [op(i0 + j) for j in range(n_ops)] if n_ops else [],
              "since": cursor, "reseed": False})
    return (time.monotonic() - t0) * 1000, r["cursor"]


def seed(base, n=N_SEED):
    """Register the group and seed n ops in 500-op /sync batches."""
    register(base, GID)
    cursor = 0
    for k in range(n // 500):
        _, cursor = sync(base, cursor, 500, k * 500)
    assert cursor == n, cursor
    return cursor


def bench(base):
    cursor = seed(base)

    out = {}
    i = N_SEED
    for label, n, reps in (("sync_idle", 0, REPS), ("sync_1op", 1, REPS),
                           ("sync_3ops", 3, REPS), ("sync_500ops", 500, REPS)):
        for _ in range(2):  # warm-up
            i += n
            _, cursor = sync(base, cursor, n, i - n)
        ts = []
        for _ in range(reps):
            i += n
            ms, cursor = sync(base, cursor, n, i - n)
            ts.append(ms)
        out[label] = round(median(ts), 2)

    # 10 000-op catch-up: 20 consecutive /sync of 500, total wall time.
    ts = []
    for _ in range(REPS_SLOW):
        for k in range(REPS_SLOW * 2):  # 3 runs x 20 batches x 500 ops = 3k new ops
            i += 500
            _, cursor = sync(base, cursor, 500, i - 500)
        t0 = time.monotonic()
        for _ in range(20):
            i += 500
            _, cursor = sync(base, cursor, 500, i - 500)
        ts.append((time.monotonic() - t0) * 1000)
    out["catchup_10k_ms"] = round(median(ts), 1)

    # Old contract: one change = push (1 op) + pull = 2 round trips.
    ts = []
    for _ in range(REPS):
        i += 1
        t0 = time.monotonic()
        req("POST", f"{base}/api/v1/groups/{GID}/ops", {"ops": [op(i - 1)], "reseed": False})
        r = req("GET", f"{base}/api/v1/groups/{GID}/ops?since={cursor}")
        ts.append((time.monotonic() - t0) * 1000)
        cursor = r["cursor"]  # the /ops push endpoint returns no cursor
    out["old_contract_push_plus_pull_ms"] = round(median(ts), 2)

    # 10k fresh join: full pull, real wire body size raw + gzip-5.
    def raw_get(path):
        req = urllib.request.Request(base + path, headers={"X-API-Key": KEY})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    body = raw_get(f"/api/v1/groups/{GID}/ops?since=0")
    ts = []
    for _ in range(REPS_SLOW):
        t0 = time.monotonic()
        raw_get(f"/api/v1/groups/{GID}/ops?since=0")
        ts.append((time.monotonic() - t0) * 1000)
    out["join_10k_ms"] = round(median(ts), 1)
    out["join_10k_raw_bytes"] = len(body)
    out["join_10k_gzip5_bytes"] = len(gzip.compress(body, 5))

    # SSE wake latency: push completes -> full wake frame received.
    hostport = urllib.parse.urlsplit(base).netloc
    conn = httpc.HTTPConnection(*hostport.split(":"), timeout=20)
    conn.request("GET", f"/api/v1/groups/{GID}/events",
                 headers={"X-API-Key": KEY, "Accept": "text/event-stream"})
    resp = conn.getresponse()
    assert resp.status == 200, resp.status
    buf = b""
    while b": connected" not in buf:
        chunk = resp.read(1)
        if not chunk:
            raise SystemExit("SSE stream closed before ': connected'")
        buf += chunk
    wake = []
    for _ in range(REPS):
        i += 1
        t0 = time.monotonic()
        req("POST", f"{base}/api/v1/groups/{GID}/sync",
             {"ops": [op(i - 1)], "since": cursor, "reseed": False})
        cursor += 1
        while True:
            chunk = resp.read(1)
            if not chunk:
                raise SystemExit("SSE stream closed mid-bench")
            buf += chunk
            j = buf.find(b"event: op")
            if j >= 0 and buf.find(b"\n\n", j) >= 0:
                break
        wake.append((time.monotonic() - t0) * 1000)
    out["sse_wake_ms"] = round(median(wake), 2)
    # E2E: peer learns of the change = wake + its /sync.
    e2e = []
    for _ in range(REPS):
        i += 1
        t0 = time.monotonic()
        req("POST", f"{base}/api/v1/groups/{GID}/sync",
             {"ops": [op(i - 1)], "since": cursor, "reseed": False})
        cursor += 1
        while True:
            chunk = resp.read(1)
            if not chunk:
                raise SystemExit("SSE stream closed mid-bench")
            buf += chunk
            j = buf.find(b"event: op")
            if j >= 0 and buf.find(b"\n\n", j) >= 0:
                break
        t1 = time.monotonic()
        r2 = req("POST", f"{base}/api/v1/groups/{GID}/sync",
                  {"ops": [], "since": cursor - 1, "reseed": False})
        assert r2["cursor"] == cursor
        e2e.append((time.monotonic() - t0) * 1000)
    out["e2e_wake_plus_sync_ms"] = round(median(e2e), 2)
    conn.close()
    return out


def main():
    base_py, base_rust, py, ru = setup()
    try:
        wait_up(base_py); wait_up(base_rust)
        res_py = bench(base_py)
        res_rust = bench(base_rust)
    finally:
        for p in (ru, py):
            try:
                p.terminate()
            except Exception:
                pass
        time.sleep(1.5)
        for p in (ru, py):
            try:
                p.kill()
            except Exception:
                pass
    for d in (DB_RUST, DB_PY):
        if os.path.exists(d):
            os.remove(d)

    rows = [
        ("idle sync (fallback poll, 1 req)", "sync_idle", " ms"),
        ("daily change, 1 op (1 req, was 2)", "sync_1op", " ms"),
        ("3 ops (1 req, was 2)", "sync_3ops", " ms"),
        ("500-op batch (1 req, pull incl.)", "sync_500ops", " ms"),
        ("10k catch-up (20 x /sync 500)", "catchup_10k_ms", " ms"),
        ("OLD contract: 1 op push+pull (2 req)", "old_contract_push_plus_pull_ms", " ms"),
        ("10k fresh-join pull", "join_10k_ms", " ms"),
        ("SSE wake: push -> frame received", "sse_wake_ms", " ms"),
        ("E2E peer up-to-date (wake + /sync)", "e2e_wake_plus_sync_ms", " ms"),
    ]
    print(f"{'scenario':<42} {'Python+SQLite':>14} {'Rust+SQLite':>14}  ratio")
    for label, key, unit in rows:
        a, b = res_py[key], res_rust[key]
        r = f"{a / b:.1f}x" if b else "-"
        print(f"{label:<42} {a:>12}{unit} {b:>12}{unit}  {r}")
    print(f"\n10k join size: py raw={res_py['join_10k_raw_bytes'] / 1e6:.1f} MB "
          f"gzip5={res_py['join_10k_gzip5_bytes'] / 1e6:.2f} MB | "
          f"rust raw={res_rust['join_10k_raw_bytes'] / 1e6:.1f} MB "
          f"gzip5={res_rust['join_10k_gzip5_bytes'] / 1e6:.2f} MB")
    with open("/tmp/net-bench.json", "w") as f:
        json.dump({"python": res_py, "rust": res_rust}, f, indent=2)
    print("wrote /tmp/net-bench.json")


if __name__ == "__main__":
    main()
