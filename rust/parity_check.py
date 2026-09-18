#!/usr/bin/env python3
"""A/B parity: Python (8002) vs Rust (8001) for /sync + /events (SSE).

Verifies the new network contract is byte-compatible across backends:
- register group -> same group_id semantics
- POST /sync with same ops -> identical {accepted, ops, cursor, serverGeneration}
  (modulo serverGeneration, which is process-specific and compared by shape)
- GET /events -> identical response headers (content-type, cache-control,
  x-accel-buffering) and identical SSE wake frame on a concurrent push.
Exit 0 = full parity, 1 = divergence (printed).
"""
import json, os, shutil, socket, subprocess, sys, threading, time, urllib.request

ROOT = "/home/supermut59000/Work/Ardoise"
PYV = f"{ROOT}/backend/.venv/bin/python"
RUST = f"{ROOT}/rust/target/release/ardoise"
KEY = "parity42"
OPSLIMIT = 3
failures = []

def note(ok, label, extra=""):
    print(f"  [{'OK' if ok else 'DIVERGE'}] {label}" + (f"  {extra}" if extra else ""))
    if not ok:
        failures.append(label)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def start(server, args, env, logf, cwd=None):
    with open(logf, "w") as lf:
        return subprocess.Popen([server] + args, env=env, cwd=cwd,
                                stdout=lf, stderr=subprocess.STDOUT,
                                start_new_session=True)

def http(method, url, body=None, key=KEY):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if key: req.add_header("X-API-Key", key)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode() or "null")

def http_status(method, url, body=None, key=KEY):
    """Like http() but returns (status, body) instead of raising on 4xx/5xx."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if key: req.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read().decode() or ""
        try: return e.code, json.loads(raw)
        except json.JSONDecodeError: return e.code, raw

def register(base, gid):
    return http("POST", f"{base}/api/v1/groups/register", {"groupId": gid})

def sse_headers_and_first(base, gid):
    """Open /events, read headers + first comment line + one wake, then close."""
    import http.client
    c = http.client.HTTPConnection("127.0.0.1", int(base.rsplit(":", 1)[1]), timeout=15)
    c.request("GET", f"/api/v1/groups/{gid}/events", headers={"X-API-Key": KEY})
    r = c.getresponse()
    hdrs = {k.lower(): v for k, v in r.getheaders()}
    # read incrementally until we see the end of the first block ('\n\n')
    buf = b""
    while b"\n\n" not in buf:
        chunk = r.read(1)
        if not chunk: break
        buf += chunk
    first_block = buf.split(b"\n\n")[0].decode()
    return hdrs, first_block, c, r

def main():
    p_rust, p_py = free_port(), free_port()
    base_rust, base_py = f"http://127.0.0.1:{p_rust}", f"http://127.0.0.1:{p_py}"
    db_rust, db_py = "/tmp/par-rust.db", "/tmp/par-py.db"
    for d in (db_rust, db_py):
        if os.path.exists(d): os.remove(d)

    env_rust = dict(os.environ, DATA_FILE=db_rust, API_KEY=KEY, PORT=str(p_rust))
    env_py = dict(os.environ, DATABASE_URL=f"sqlite:///{db_py}", API_KEY=KEY,
                  DB_HOST="x", DB_USER="x", DB_PASSWORD="x")
    # The app never auto-creates tables; do it once for the Python side
    # before serving. The Rust binary creates its own.
    subprocess.run(
        [PYV, "-c",
         "import os;os.environ['DATABASE_URL']='sqlite:////tmp/par-py.db';"
         "import app.models;"
         "from app.core.database import Base, engine;"
         "Base.metadata.create_all(engine)"],
        cwd=f"{ROOT}/backend",
        env=dict(os.environ, DB_HOST='x', DB_USER='x', DB_PASSWORD='x'),
        check=True,
    )
    py = start(PYV, ["-m", "uvicorn", "app.main:app", "--port", str(p_py)],
               env_py, "/tmp/par-py.log", cwd=f"{ROOT}/backend")
    ru = start(RUST, [], env_rust, "/tmp/par-rust.log")

    def up(name, base):
        for _ in range(100):
            try:
                http("GET", f"{base}/api/v1/system/ping", key=None); return True
            except Exception:
                time.sleep(0.1)
        return False

    try:
        assert up("py", base_py), "python backend did not come up"
        assert up("rust", base_rust), "rust backend did not come up"

        gid = "g-parity"
        r1 = register(base_py, gid); r2 = register(base_rust, gid)
        note(r1.get("groupId") == r2.get("groupId") == gid,
             "register group_id", f"py={r1.get('groupId')} rust={r2.get('groupId')}")

        ops = [{"opId": f"op-{i}", "groupId": gid, "entity": "expense",
                "entityId": f"ex-{i}", "action": "create",
                "payload": {"amount": i + 1}, "actor": "parity",
                "lamport": i + 1, "createdAt": 1700000000 + i}
               for i in range(OPSLIMIT)]
        s1 = http("POST", f"{base_py}/api/v1/groups/{gid}/sync",
                  {"ops": ops, "since": 0, "reseed": False})
        s2 = http("POST", f"{base_rust}/api/v1/groups/{gid}/sync",
                  {"ops": ops, "since": 0, "reseed": False})
        note(s1.get("accepted") == s2.get("accepted") == OPSLIMIT,
             "sync accepted", f"py={s1.get('accepted')} rust={s2.get('accepted')}")
        note(s1.get("cursor") == s2.get("cursor"),
             "sync cursor", f"py={s1.get('cursor')} rust={s2.get('cursor')}")
        note(s1.get("ops") == s2.get("ops"),
             "sync ops body identical")
        note(bool(s1.get("serverGeneration")) and bool(s2.get("serverGeneration"))
             and isinstance(s1.get("serverGeneration"), str)
             and isinstance(s2.get("serverGeneration"), str),
             "sync serverGeneration present (str)")

        # idempotency: same opIds again -> accepted 0, same cursor, ops still there
        d1 = http("POST", f"{base_py}/api/v1/groups/{gid}/sync",
                  {"ops": ops, "since": 0, "reseed": False})
        d2 = http("POST", f"{base_rust}/api/v1/groups/{gid}/sync",
                  {"ops": ops, "since": 0, "reseed": False})
        note(d1.get("accepted") == d2.get("accepted") == 0,
             "sync dedup accepted=0", f"py={d1.get('accepted')} rust={d2.get('accepted')}")
        note(d1.get("cursor") == d2.get("cursor"), "sync dedup cursor")
        note(d1.get("ops") == d2.get("ops"), "sync dedup ops identical")

        # error-path parity: unknown group 404, bad since 422 (both /sync and /events)
        e1 = http_status("POST", f"{base_py}/api/v1/groups/nope/sync", {"ops": [], "since": 0, "reseed": False})
        e2 = http_status("POST", f"{base_rust}/api/v1/groups/nope/sync", {"ops": [], "since": 0, "reseed": False})
        note(e1[0] == e2[0] == 404, "sync 404 unknown group", f"py={e1[0]} rust={e2[0]}")
        e1 = http_status("POST", f"{base_py}/api/v1/groups/{gid}/sync", {"ops": [], "since": -1, "reseed": False})
        e2 = http_status("POST", f"{base_rust}/api/v1/groups/{gid}/sync", {"ops": [], "since": -1, "reseed": False})
        note(e1[0] == e2[0] == 422, "sync 422 since<0", f"py={e1[0]} rust={e2[0]}")
        e1 = http_status("GET", f"{base_py}/api/v1/groups/nope/events", key=KEY)
        e2 = http_status("GET", f"{base_rust}/api/v1/groups/nope/events", key=KEY)
        note(e1[0] == e2[0] == 404, "events 404 unknown group", f"py={e1[0]} rust={e2[0]}")

        # SSE headers parity
        h1, fb1, c1, r1s = sse_headers_and_first(base_py, gid)
        h2, fb2, c2, r2s = sse_headers_and_first(base_rust, gid)
        note(h1.get("content-type") == h2.get("content-type") == "text/event-stream; charset=utf-8",
             "SSE content-type", f"py={h1.get('content-type')} rust={h2.get('content-type')}")
        note(h1.get("cache-control") == h2.get("cache-control") == "no-cache",
             "SSE cache-control", f"py={h1.get('cache-control')} rust={h2.get('cache-control')}")
        note(h1.get("x-accel-buffering") == h2.get("x-accel-buffering") == "no",
             "SSE x-accel-buffering", f"py={h1.get('x-accel-buffering')} rust={h2.get('x-accel-buffering')}")
        note(fb1.strip() == fb2.strip() == ": connected",
             "SSE first comment", f"py={fb1.strip()!r} rust={fb2.strip()!r}")

        # push to each backend while its SSE stream is open -> it must wake
        # with event: op. (One push per backend: each server wakes its own
        # subscribers for its own rows.)
        def push(base):
            http("POST", f"{base}/api/v1/groups/{gid}/ops",
                 {"ops": [{"opId": "wake-op", "groupId": gid, "entity": "expense",
                           "entityId": "ex-wake", "action": "create",
                           "payload": {"amount": 7}, "actor": "parity",
                           "lamport": 99, "createdAt": 1700000100}],
                  "reseed": False})

        def read_until_op(conn, resp, deadline=15.0):
            # Read until the FULL 'event: op' frame is in: the event line AND
            # its terminating blank line (a frame ends at the first \n\n after
            # 'event: op'). Stopping at the event line alone would leave the
            # data line unread.
            buf = b""
            end = time.time() + deadline
            while time.time() < end:
                chunk = resp.read(1)
                if not chunk: break
                buf += chunk
                i = buf.find(b"event: op")
                if i >= 0 and buf.find(b"\n\n", i) >= 0:
                    break
            return buf.decode()

        push(base_py);  b1 = read_until_op(c1, r1s)
        push(base_rust); b2 = read_until_op(c2, r2s)
        def extract_op_frame(buf):
            # find the 'event: op' frame and its data line
            i = buf.find("event: op")
            if i < 0: return None
            seg = buf[i:]
            j = seg.find("\n\n")
            return seg[:j].strip() if j > 0 else None
        f1, f2 = extract_op_frame(b1), extract_op_frame(b2)
        note(f1 is not None and f2 is not None, "SSE wake event:op received",
             f"py={f1!r} rust={f2!r}")
        # data payload should be identical {"seq": N}
        d1s = f1.split("data:")[1].strip() if f1 and "data:" in f1 else None
        d2s = f2.split("data:")[1].strip() if f2 and "data:" in f2 else None
        if d1s and d2s:
            j1, j2 = json.loads(d1s), json.loads(d2s)
            note(set(j1) == set(j2) == {"seq"} and j1["seq"] == j2["seq"],
                 "SSE wake data {seq}", f"py={d1s} rust={d2s}")
        else:
            note(False, "SSE wake data {seq}", f"py={d1s!r} rust={d2s!r}")
        try: c1.close(); c2.close()
        except Exception: pass
    finally:
        for p in (ru, py):
            try: p.terminate()
            except Exception: pass
        time.sleep(1.5)
        for p in (ru, py):
            try: p.kill()
            except Exception: pass
    for d in (db_rust, db_py):
        if os.path.exists(d): os.remove(d)

    print("\n=== PARITY RESULT ===")
    if failures:
        print("DIVERGENCES:", failures); sys.exit(1)
    print("FULL PARITY: /sync + /events identical across Python and Rust"); sys.exit(0)

if __name__ == "__main__":
    main()
