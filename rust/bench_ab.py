#!/usr/bin/env python3
"""A/B bench: Ardoise Python (uvicorn+SQLite:8002) vs Rust (axum+SQLite:8001).
Same seeded dataset, same requests, median of N. Writes /tmp/ab-results.json.
"""
import json, random, sqlite3, statistics, subprocess, time, urllib.request, urllib.error

N = 7
KEY = "secret42"
REPO = os.path.dirname(os.path.abspath(__file__)) + "/../.."  # rust/ -> repo
GROUP = "g1"

def seed(path, n_ops):
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, share_code TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL,
            group_id TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
            action TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL,
            lamport INTEGER NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_operations_group_seq ON operations (group_id, seq);
        CREATE INDEX IF NOT EXISTS ix_operations_op_id ON operations (op_id);
        CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device_id TEXT NOT NULL, group_ids TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS server_meta (id INTEGER PRIMARY KEY, generation TEXT NOT NULL);
    """)
    conn.execute("DELETE FROM operations"); conn.execute("DELETE FROM groups"); conn.execute("DELETE FROM server_meta")
    # Reset the AUTOINCREMENT counter so seq restarts at 1 (stable cursors).
    conn.execute("DELETE FROM sqlite_sequence WHERE name='operations'")
    from datetime import datetime, timezone
    nowiso = datetime(2024, 1, 1).strftime("%Y-%m-%d %H:%M:%S.%f")
    conn.execute("INSERT OR IGNORE INTO groups VALUES ('g1','ABTEST01',?)", (nowiso,))
    conn.execute("INSERT OR IGNORE INTO server_meta VALUES (1,'gen-1')")
    random.seed(42)
    members = [f"m{i}" for i in range(5)]
    words = ["Restaurant","Cafe","Cinema","Train","Hotel","Marche","Piscine","Musée","Carburant","Location"]
    now = 1_700_000_000_000
    rows = []
    for i in range(n_ops):
        entity = random.choices(["expense","member","settlement"], [80,10,10])[0]
        payload = {
            "description": f"{random.choice(words)} {random.randint(1,99)}",
            "amountCents": random.randint(100, 80000),
            "paidBy": random.choice(members),
        }
        if entity == "member": payload = {"name": f"Personne {i}"}
        if entity == "settlement": payload = {"amountCents": random.randint(500, 50000), "settledBy": random.choice(members)}
        rows.append((f"op{i:07d}", "g1", entity, f"e{i:07d}", "create",
                     json.dumps(payload, ensure_ascii=False), f"actor{random.randint(1,5)}", i, now + i*1000, nowiso))
    conn.executemany("INSERT INTO operations (op_id,group_id,entity,entity_id,action,payload,actor,lamport,created_at,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit(); conn.close()

def req(url, data=None, method=None):
    r = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                               headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            body = resp.read()
            return (time.perf_counter() - t0) * 1000, resp.status, body
    except urllib.error.HTTPError as e:
        return (time.perf_counter() - t0) * 1000, e.code, e.read()

def push_batch(base, ops):
    return req(f"{base}/api/v1/groups/{GROUP}/ops", json.dumps({"ops": ops}).encode())

def bench_one(base, label, n_ops=10000):
    print(f"\n=== {label} (seed {n_ops} ops) ===")
    ops = [{"opId": f"b{i:05d}", "groupId": GROUP, "entity": "expense", "entityId": f"b{i:05d}",
            "action": "create", "payload": {"description": f"Push {i}", "amountCents": 1234},
            "actor": "bench", "lamport": i, "createdAt": 1_700_000_000_000 + i} for i in range(500)]
    results = {}
    # warmup (connection, page cache)
    req(f"{base}/api/v1/system/ping")
    push_counter = [0]
    def push_fresh():
        # fresh opIds each call: every iteration exercises the insert path
        tag = f"b{push_counter[0]:03d}"
        push_counter[0] += 1
        fresh = [dict(o, opId=f"{tag}-{o['opId']}", entityId=f"{tag}-{o['entityId']}") for o in ops]
        return push_batch(base, fresh)
    # Pulls first: the push_500 benchmark appends rows, so it must run last
    # to keep the pull result sets stable across iterations.
    for name, fn in [
        ("ping", lambda: req(f"{base}/api/v1/system/ping")),
        ("pull_full_10k", lambda: req(f"{base}/api/v1/groups/{GROUP}/ops?since=0")),
        ("pull_incremental_10", lambda: req(f"{base}/api/v1/groups/{GROUP}/ops?since={n_ops - 10}")),
        ("pull_empty", lambda: req(f"{base}/api/v1/groups/{GROUP}/ops?since={n_ops}")),
        ("get_group", lambda: req(f"{base}/api/v1/groups/{GROUP}")),
        ("push_500", push_fresh),
    ]:
        samples = []
        for _ in range(N + 1):  # +1 warmup
            ms, status, body = fn()
            if status != 200:
                print(f"  {name}: HTTP {status} {body[:120]!r}")
                break
            samples.append(ms)
        med = statistics.median(samples[1:]) if len(samples) > 1 else float("nan")
        best = min(samples[1:]) if len(samples) > 1 else float("nan")
        results[name] = {"median_ms": round(med, 2), "best_ms": round(best, 2), "n": len(samples) - 1}
        print(f"  {name:22s} median {med:8.2f} ms   best {best:8.2f} ms")
    return results

def rss_kb(port):
    # /proc/net/tcp inode for the LISTEN socket -> owner pid -> VmRSS (kB)
    import os
    target = ":" + format(port, "X")
    inode = None
    for line in open("/proc/net/tcp").readlines()[1:]:
        p = line.split()
        if p[1].endswith(target) and p[3] == "0A":
            inode = p[9]; break
    if inode is None:
        print(f"  (no listener on :{port})"); return None
    tag = f"socket:[{inode}]"
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                if os.readlink(f"/proc/{pid}/fd/{fd}") == tag:
                    for line in open(f"/proc/{pid}/status"):
                        if line.startswith("VmRSS:"): return int(line.split()[1])
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    print(f"  (pid not found for :{port})")
    return None

def start_server(label):
    subprocess.run(["pkill", "-f", "uvicorn app.main"], capture_output=True)
    subprocess.run(["pkill", "-f", "ardoise"], capture_output=True)
    time.sleep(0.5)
    dbf = f"/tmp/ab-{label}.db"
    if label == "python":
        backend = REPO + "/backend"
        cmd = ["bash", "-c",
            f"cd {backend} && "
            "DB_HOST=x DB_USER=x DB_PASSWORD=x API_KEY=secret42 "
            "DATABASE_URL=sqlite:////tmp/ab-python.db "
            "nohup .venv/bin/uvicorn app.main:app --port 8002 --log-level warning >/tmp/ab-srv.log 2>&1 &"]
    else:
        binpath = REPO + "/rust/target/release/ardoise"
        cmd = ["bash", "-c",
            "API_KEY=secret42 PORT=8001 DATA_FILE=/tmp/ab-rust.db "
            f"nohup {binpath} >/tmp/ab-srv.log 2>&1 &"]
    subprocess.run(cmd)
    base = "http://127.0.0.1:8002" if label == "python" else "http://127.0.0.1:8001"
    for _ in range(40):
        try:
            ms, status, _ = req(f"{base}/api/v1/system/ping")
            if status == 200: return base
        except Exception: pass
        time.sleep(0.25)
    raise SystemExit(f"server {label} did not come up: {open('/tmp/ab-srv.log').read()[-500:]}")

def main():
    out = {}
    for label, port in [("python", "8002"), ("rust", "8001")]:
        subprocess.run(["pkill", "-f", "uvicorn app.main"], capture_output=True)
        subprocess.run(["pkill", "-f", "target/release/ardoise"], capture_output=True)
        time.sleep(0.5)
        seed(f"/tmp/ab-{label}.db", 10000)
        base = start_server(label)
        r = bench_one(base, label)
        time.sleep(1)  # let DB writes settle before the snapshot
        rss = rss_kb(port)
        r["rss_mb"] = round(rss / 1024, 1) if rss else None
        print(f"  RSS: {r['rss_mb']} MB")
        out[label] = r
    with open("/tmp/ab-results.json", "w") as f:
        json.dump(out, f, indent=1)
    subprocess.run(["pkill", "-f", "uvicorn app.main"], capture_output=True)
    subprocess.run(["pkill", "-f", "target/release/ardoise"], capture_output=True)

if __name__ == "__main__":
    main()
