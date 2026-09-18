#!/usr/bin/env python3
"""Fiche 05 recalc for the RUST backend (axum + SQLite).

Reproduces every measured figure in context/05_capacity-and-limits.md on the
Rust binary, side by side with the original Python+MariaDB numbers:
  - storage per op on disk (worst-case and realistic payloads)
  - sync timings: up-to-date pull, daily push (1-3 ops), 500-op batch,
    10k-op catch-up push, fresh-join full pull (bytes + time + gzip ratio)
  - RSS
Median of 7 after warmup, loopback, fresh WAL database per scenario (same
method as fiche 05 / bench_ab.py).
"""
import gzip, json, os, random, sqlite3, statistics, subprocess, time, urllib.request, urllib.error

N = 7
KEY = "secret42"
PORT = 8001
BASE = f"http://127.0.0.1:{PORT}"
REPO = os.path.dirname(os.path.abspath(__file__))
BIN = REPO + "/target/release/ardoise"
GROUP = "g1"
NOW_ISO = "2024-01-01 00:00:00.000000"
T0 = 1_700_000_000_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, share_code TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL,
    group_id TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
    action TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL,
    lamport INTEGER NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_operations_group_seq ON operations(group_id, seq);
CREATE INDEX IF NOT EXISTS ix_operations_op_id ON operations(op_id);
CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device_id TEXT NOT NULL, group_ids TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS server_meta (id INTEGER PRIMARY KEY, generation TEXT NOT NULL);
"""

# --- payload shapes -------------------------------------------------------

def worst_case_payload(i, members):
    """fiche 05 worst case: expense create, 5-member split, long description, emoji."""
    desc = ("Déjeuner d'anniversaire très long "
            "avec le restaurant gastronomique de la ville 🍽️🎂🥂👨‍👩‍👧‍👦 "
            "plat principal, dessert, vin et pourbois inclus ")[:260]
    return {
        "groupId": GROUP, "description": desc + f" n°{i}",
        "amountCents": random.randint(10000, 200000),
        "paidBy": random.choice(members), "spentAt": "2024-01-01",
        "emoji": "🍽️", "brand": "Restaurant", "splitMode": "unequal",
        "shares": [{"memberId": m, "amountCents": random.randint(1000, 40000)} for m in members],
        "createdAt": T0 + i,
    }

def realistic_payload(i, members):
    words = ["Restaurant", "Cafe", "Cinema", "Train", "Hotel", "Marche"]
    return {
        "groupId": GROUP,
        "description": f"{random.choice(words)} {random.randint(1, 99)}",
        "amountCents": random.randint(100, 80000),
        "paidBy": random.choice(members), "spentAt": "2024-01-01",
        "emoji": "", "brand": "", "splitMode": "equal",
        "shares": [{"memberId": m, "amountCents": 0} for m in members[:3]],
        "createdAt": T0 + i,
    }

def wire_op(i, payload, tag="w"):
    return {"opId": f"{tag}{i:07d}", "groupId": GROUP, "entity": "expense",
            "entityId": f"{tag}{i:07d}", "action": "create", "payload": payload,
            "actor": f"actor{random.randint(1, 5)}", "lamport": i, "createdAt": T0 + i}

# --- storage --------------------------------------------------------------

def seed_db(path, n, payload_fn, tag="s"):
    if os.path.exists(path):
        for suffix in ("", "-wal", "-shm"):
            try: os.unlink(path + suffix)
            except FileNotFoundError: pass
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    random.seed(42)
    members = [f"m{i}" for i in range(5)]
    conn.execute("INSERT INTO groups VALUES ('g1','CAPTEST1',?)", (NOW_ISO,))
    conn.execute("INSERT INTO server_meta VALUES (1,'gen-1')")
    rows = []
    for i in range(n):
        op = wire_op(i, payload_fn(i, members), tag)
        rows.append((op["opId"], GROUP, "expense", op["entityId"], "create",
                     json.dumps(op["payload"], ensure_ascii=False), op["actor"], i, T0 + i, NOW_ISO))
    conn.executemany("INSERT INTO operations (op_id,group_id,entity,entity_id,action,payload,actor,lamport,created_at,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    return os.path.getsize(path)

def storage_report():
    print("=== Storage per operation (SQLite, WAL checkpointed) ===")
    wc_wire = len(json.dumps(wire_op(0, worst_case_payload(0, [f"m{i}" for i in range(5)]))["payload"], ensure_ascii=False))
    wc_full = len(json.dumps(wire_op(0, worst_case_payload(0, [f"m{i}" for i in range(5)])), ensure_ascii=False))
    rc_full = len(json.dumps(wire_op(0, realistic_payload(0, [f"m{i}" for i in range(3)])), ensure_ascii=False))
    for label, fn, tag in [("worst-case", worst_case_payload, "wc"), ("realistic", realistic_payload, "rc")]:
        for n in ([10_000, 100_000] if label == "worst-case" else [10_000]):
            size = seed_db(f"/tmp/cap-{tag}-{n}.db", n, fn, tag)
            print(f"  {label:10s} n={n:>7,}: file {size/1e6:8.2f} MB  ->  {size/n:7.1f} B/op on disk")
    print(f"  wire JSON: worst-case op {wc_full} B (payload alone {wc_wire} B) | realistic op {rc_full} B")
    subprocess.run(["rm", "-f"] + [f"/tmp/cap-{t}-{n}.db*" for t, n in [("wc", 10_000), ("wc", 100_000), ("rc", 10_000)]])

# --- server timings -------------------------------------------------------

def req(url, data=None, method=None):
    r = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                               headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return (time.perf_counter() - t0) * 1000, resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return (time.perf_counter() - t0) * 1000, e.code, e.read()

def start_server(dbfile):
    subprocess.run(["pkill", "-x", "ardoise"], capture_output=True)
    time.sleep(0.4)
    subprocess.run(["bash", "-c",
        f"API_KEY={KEY} PORT={PORT} DATA_FILE={dbfile} nohup {BIN} >/tmp/cap-srv.log 2>&1 &"])
    for _ in range(40):
        try:
            if req(f"{BASE}/api/v1/system/ping")[1] == 200:
                return True
        except Exception:
            pass
        time.sleep(0.25)
    raise SystemExit("rust server did not come up: " + open("/tmp/cap-srv.log").read()[-400:])

def rss_mb():
    pids = subprocess.run(["pgrep", "-x", "ardoise"], capture_output=True, text=True).stdout.split()
    total = 0
    for pid in pids:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("VmRSS:"):
                total += int(line.split()[1])
    return round(total / 1024, 1) if pids else None

def med(fn, n=N):
    fn()  # warmup
    return statistics.median(fn()[0] for _ in range(n))

def timings_report(n_ops=10_000):
    print(f"\n=== Sync timings (Rust, loopback, fresh seed of {n_ops:,} realistic ops) ===")
    dbf = "/tmp/cap-server.db"
    seed_db(dbf, n_ops, realistic_payload, "sv")
    start_server(dbf)
    random.seed(7)
    members = [f"m{i}" for i in range(3)]
    uniq = [0]  # fresh opIds every call: the dedup path is not the insert path
    def fresh_ops(k, prefix):
        uniq[0] += 1
        tag = f"{prefix}{uniq[0]:03d}"
        return [wire_op(i, realistic_payload(i, members), tag=f"{tag}{i:04d}") for i in range(k)]

    def pull_at(cursor):
        return req(f"{BASE}/api/v1/groups/{GROUP}/ops?since={cursor}")
    med(lambda: pull_at(n_ops))  # warm the exact query shape
    cursor = json.loads(pull_at(n_ops)[2])["cursor"]
    print(f"  pull up-to-date (every-20s poll)   {med(lambda: pull_at(cursor)):8.2f} ms")

    # Fresh join of the CLEAN 10k group (before the pushes below grow it).
    ms, st, body = req(f"{BASE}/api/v1/groups/{GROUP}/ops?since=0")
    data = json.loads(body)
    gz5 = len(gzip.compress(body, 5))  # Caddy default gzip level
    print(f"  fresh join full pull ({len(data['ops']):,} ops)  {ms:8.0f} ms | {len(body)/1e6:5.1f} MB raw, {gz5/1e6:4.1f} MB gzip-5")

    print(f"  daily push 1 op                    {med(lambda: req(f'{BASE}/api/v1/groups/{GROUP}/ops', json.dumps({'ops': fresh_ops(1, 'd')}).encode())):8.2f} ms")
    print(f"  daily push 3 ops                   {med(lambda: req(f'{BASE}/api/v1/groups/{GROUP}/ops', json.dumps({'ops': fresh_ops(3, 'e')}).encode())):8.2f} ms")
    print(f"  push 500-op batch                  {med(lambda: req(f'{BASE}/api/v1/groups/{GROUP}/ops', json.dumps({'ops': fresh_ops(500, 'b')}).encode())):8.2f} ms")

    # 10k catch-up push: 20 fresh batches of 500, total wall time
    t0 = time.perf_counter()
    for b in range(20):
        ms, st, _ = req(f"{BASE}/api/v1/groups/{GROUP}/ops", json.dumps({"ops": fresh_ops(500, "cu")}).encode())
        if st != 200: raise SystemExit(f"catch-up batch {b} -> HTTP {st}")
    total = (time.perf_counter() - t0) * 1000
    print(f"  10 000-op catch-up push (20 batches) {total:8.0f} ms total")

    time.sleep(1)
    print(f"  RSS: {rss_mb()} MB | binary: {os.path.getsize(BIN)/1e6:.1f} MB")
    subprocess.run(["pkill", "-x", "ardoise"], capture_output=True)
    subprocess.run(["rm", "-f", dbf + "*"])

if __name__ == "__main__":
    if not os.path.exists(BIN):
        raise SystemExit("build first: cargo build --release")
    storage_report()
    timings_report()
