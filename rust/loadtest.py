#!/usr/bin/env python3
"""Load ladder: 100 -> 1,000,000 simulated users, A/B on both backends.

Profile per user (faithful to the shipped client):
  - 1 HTTP keep-alive connection (POST /sync) + 1 SSE connection (GET /events)
  - first /sync = join from cursor 0 (excluded from stats)
  - then every uniform(18,22)s: POST /sync; 30% of syncs carry 1-3 ops,
    0.1% carry a 500-op catch-up batch
  - the SSE stream is read continuously (no artificial backpressure)

Groups: 1 per 50 users (100 users -> 2 groups ... 1M -> 20k groups).
Probe: dedicated group, 1 pusher (1 op / 5s) + up to 100 watchers ->
SSE wake p50/p95 measured while the rest of the load is hammering.

Machine constraint (itself a finding): ulimit -n = 524288 FDs per process
and 2 connections per user => the generator caps around ~260k users; the
1M level reports the actually achieved count.

Levels alternate (rust@U then python@U) so both backends see the same
machine state. Writes /tmp/loadtest.json. Run:
  cd rust && cargo build --release && rm -f /tmp/netb-* \
    && ../backend/.venv/bin/python -u loadtest.py
"""
import asyncio, json, os, random, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parity_check import free_port, start, register, PYV, RUST, ROOT, KEY  # noqa: E402
import net_bench  # noqa: E402

HOST = "127.0.0.1"
LEVELS = [int(x) for x in
          os.environ.get("LEVELS", "100,500,1000,10000,100000,1000000").split(",")]
STEADY = {100: 60, 500: 60, 1_000: 60, 10_000: 75, 100_000: 90, 1_000_000: 90}
WAVE = 50_000            # users spawned per wave (caps generator memory spikes)
RAMP_RATE = int(os.environ.get("RAMP_RATE", "0"))  # users/s, 0 = full blast
SYNC_TIMEOUT = 15.0      # s; a phone gives up even sooner
RAMP_TIMEOUT = 120.0     # s per wave
RUST_ONLY = os.environ.get("RUST_ONLY")   # skip python levels
CGROUP = os.environ.get("CGROUP")         # cgroup dir: server pids moved in
WRITE_PROB = float(os.environ.get("WRITE_PROB", "0.31"))      # storm default
CATCHUP_PROB = float(os.environ.get("CATCHUP_PROB", "0.001")) # storm default

def to_cgroup(pid):
    if CGROUP:
        with open(f"{CGROUP}/cgroup.procs", "a") as f:
            f.write(f"{pid}\n")
PROBE_WATCHERS = 100
PROBE_INTERVAL = 5.0
PORT = 0                 # set per level


# ---------- minimal keep-alive HTTP/1.1 over asyncio streams ----------

class Conn:
    __slots__ = ("r", "w", "buf")

    def __init__(self, r, w):
        self.r, self.w, self.buf = r, w, bytearray()

    async def _fill(self, ok, timeout):
        t0 = time.monotonic()
        while not ok():
            left = timeout - (time.monotonic() - t0)
            if left <= 0:
                raise TimeoutError
            try:
                chunk = await asyncio.wait_for(self.r.read(65536), left)
            except (asyncio.TimeoutError, TimeoutError):
                raise TimeoutError
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk

    async def request(self, line, headers, body=b"", timeout=SYNC_TIMEOUT):
        self.w.write(line.encode() + b"\r\n")
        for k, v in headers.items():
            self.w.write(f"{k}: {v}\r\n".encode())
        self.w.write(b"\r\n" + body)
        await self.w.drain()
        await self._fill(lambda: b"\r\n\r\n" in self.buf, timeout)
        i = self.buf.find(b"\r\n\r\n")
        head = bytes(self.buf[:i]).decode("latin1")
        del self.buf[:i + 4]
        lines = head.split("\r\n")
        status = int(lines[0].split()[1])
        hdrs = {}
        for l in lines[1:]:
            if ": " in l:
                k, v = l.split(": ", 1)
                hdrs[k.lower()] = v
        te = hdrs.get("transfer-encoding", "")
        if "chunked" in te.lower():
            out = bytearray()
            while True:
                await self._fill(lambda: b"\r\n" in self.buf, timeout)
                j = self.buf.find(b"\r\n")
                size = int(bytes(self.buf[:j].split(b";")[0]) or b"0", 16)
                del self.buf[:j + 2]
                if size == 0:
                    await self._fill(lambda: len(self.buf) >= 2, timeout)
                    del self.buf[:2]
                    return status, bytes(out)
                await self._fill(lambda: len(self.buf) >= size + 2, timeout)
                out += self.buf[:size]
                del self.buf[:size + 2]
        n = int(hdrs.get("content-length", "0"))
        await self._fill(lambda: len(self.buf) >= n, timeout)
        b = bytes(self.buf[:n])
        del self.buf[:n]
        return status, b


def hdrs(n):
    return {"Host": HOST, "X-API-Key": KEY, "Content-Type": "application/json",
            "Content-Length": str(n), "Connection": "keep-alive"}


def sse_request(gid):
    return (f"GET /api/v1/groups/{gid}/events HTTP/1.1\r\nHost: {HOST}\r\n"
            f"X-API-Key: {KEY}\r\nAccept: text/event-stream\r\n"
            f"Connection: keep-alive\r\n\r\n").encode()


async def open_conn(timeout=10):
    r, w = await asyncio.wait_for(asyncio.open_connection(HOST, PORT), timeout)
    return Conn(r, w)


async def do_sync(c, gid, cursor, ops, timeout=SYNC_TIMEOUT):
    body = json.dumps({"ops": ops, "since": cursor, "reseed": False}).encode()
    st, raw = await c.request(f"POST /api/v1/groups/{gid}/sync HTTP/1.1",
                              hdrs(len(body)), body, timeout)
    if st != 200:
        raise RuntimeError(f"HTTP {st}")
    return json.loads(raw)["cursor"]


def mk_op(uid, n, gid):
    return {"opId": f"lt-{uid}-{n}", "groupId": gid,
            "entity": ("expense", "member", "group", "settlement")[uid % 4],
            "entityId": f"e-{uid % 7}", "action": "update",
            "payload": {"v": n % 997}, "actor": f"u{uid}",
            "lamport": n, "createdAt": int(time.time() * 1000)}


# ---------- per-user behaviour ----------

async def user_task(uid, gid, stop, S, ramping):
    c = sw = sse = None
    try:
        c = await open_conn()
        sr, sw = await asyncio.wait_for(asyncio.open_connection(HOST, PORT), 10)
        sw.write(sse_request(gid))
        await sw.drain()
        sse = asyncio.create_task(sse_drain(sr, S))
        cursor = await do_sync(c, gid, 0, [])  # join: not in stats
        S["joined"] += 1
        ramping.discard(uid)  # ramp gate: done once joined, not on exit
        n = 0
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), random.uniform(18, 22))
            except (TimeoutError, asyncio.TimeoutError):
                pass
            if stop.is_set():
                break
            n += 1
            x = random.random()
            if x < CATCHUP_PROB:
                ops = [mk_op(uid, n * 1000 + i, gid) for i in range(500)]
            elif x < CATCHUP_PROB + WRITE_PROB:
                ops = [mk_op(uid, n * 1000 + i, gid) for i in range(random.randint(1, 3))]
            else:
                ops = []
            t0 = time.monotonic()
            try:
                cursor = await do_sync(c, gid, cursor, ops)
                S["lat"].append((time.monotonic() - t0) * 1000)
                S["reqs"] += 1
                S["ops_sent"] += len(ops)
            except TimeoutError:
                S["timeout"] += 1
                c.w.close()
                try:
                    c = await open_conn()
                except (OSError, TimeoutError):
                    break
            except Exception:
                S["connerr"] += 1
                c.w.close()
                try:
                    c = await open_conn()
                except (OSError, TimeoutError):
                    break
    except OSError as e:
        if e.errno in (24, 23):
            S["emfile"] += 1
        else:
            S["ramp_err"] += 1
    except Exception:
        # ramp-phase failure (join timeout = built-in TimeoutError in 3.13)
        S["ramp_err"] += 1
    finally:
        ramping.discard(uid)
        if c is not None:
            c.w.close()
        if sw is not None:
            sw.close()
        if sse is not None:
            sse.cancel()


async def sse_drain(sr, S):
    buf = bytearray()
    try:
        while True:
            chunk = await sr.read(65536)
            if not chunk:
                break
            buf += chunk
            i = buf.rfind(b"\n\n")
            if i > 0:
                del buf[:i + 2]
    except Exception:
        pass
    S["sse_broken"] += 1


# ---------- probe group (SSE wake at scale) ----------

async def probe_pusher(stop, P):
    try:
        c = await open_conn()
    except (OSError, TimeoutError):
        return
    cursor, n = 0, 0
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), PROBE_INTERVAL)
        except (TimeoutError, asyncio.TimeoutError):
            pass
        if stop.is_set():
            break
        n += 1
        P["last_push"] = time.monotonic()
        try:
            cursor = await do_sync(c, "g-probe", cursor, [mk_op(-1, n, "g-probe")])
        except Exception:
            P["pusher_err"] += 1
            try:
                c.w.close(); c = await open_conn()
            except (OSError, TimeoutError):
                break
    c.w.close()


async def probe_watcher(stop, P):
    try:
        sr, sw = await asyncio.wait_for(asyncio.open_connection(HOST, PORT), 10)
    except OSError:
        return
    sw.write(sse_request("g-probe"))
    await sw.drain()
    buf = bytearray()
    try:
        while True:
            chunk = await sr.read(65536)
            if not chunk:
                break
            buf += chunk
            if b"event: op" in buf:
                lp = P["last_push"]
                if lp:
                    P["wakes"].append((time.monotonic() - lp) * 1000)
            i = buf.rfind(b"\n\n")
            if i > 0:
                del buf[:i + 2]
    except Exception:
        pass
    sw.close()


# ---------- server sampling / liveness ----------

CLK = os.sysconf("SC_CLK_TCK")
PAGE = 4096


def proc_rss_mb(pid):
    with open(f"/proc/{pid}/statm") as f:
        return int(f.read().split()[1]) * PAGE / 1048576


def proc_ticks(pid):
    with open(f"/proc/{pid}/stat") as f:
        parts = f.read().split(") ")[1].split()
    return int(parts[11]) + int(parts[12])


async def sample_server(pid, stop, out):
    prev = None
    while not stop.is_set():
        try:
            ticks = proc_ticks(pid)
            now = time.monotonic()
            cpu = None
            if prev:
                cpu = (ticks - prev[1]) / CLK / (now - prev[0]) * 100
            prev = (now, ticks)
            out.append({"srv_rss_mb": round(proc_rss_mb(pid), 1),
                        "srv_cpu_pct": round(cpu, 1) if cpu is not None else None,
                        "gen_rss_mb": round(proc_rss_mb(os.getpid()), 1)})
        except Exception:
            out.append({"srv_rss_mb": None, "srv_cpu_pct": None,
                        "gen_rss_mb": None})
        await asyncio.sleep(5)


async def alive(port, timeout=3.0):
    """True/False if the server answers; None if the GENERATOR is out of
    file descriptors (EMFILE) and cannot tell the difference."""
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(HOST, port), timeout)
    except OSError as e:
        return None if e.errno in (24, 23) else False
    except Exception:
        return False
    try:
        w.write(b"GET /api/v1/system/ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        await w.drain()
        head = await asyncio.wait_for(r.read(256), timeout)
        w.close()
        return b" 200 " in head
    except Exception:
        w.close()
        return False


def env_for(name, port, db):
    if name == "rust":
        return (RUST, [],
                dict(os.environ, DATA_FILE=db, API_KEY=KEY, PORT=str(port)),
                "/tmp/netb-rust.log", None)
    return (PYV, ["-m", "uvicorn", "app.main:app", "--port", str(port)],
            dict(os.environ, DATABASE_URL=f"sqlite:///{db}", API_KEY=KEY,
                 DB_HOST="x", DB_USER="x", DB_PASSWORD="x"),
            "/tmp/netb-py.log", f"{ROOT}/backend")


async def wait_up(port, tries=60):
    for _ in range(tries):
        if await alive(port):
            return True
        await asyncio.sleep(0.5)
    return False


async def restart(name, proc, db):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    await asyncio.sleep(1)
    port = free_port()
    server, args, env, logf, cwd = env_for(name, port, db)
    p = start(server, args, env, logf, cwd)
    if not await wait_up(port):
        raise SystemExit(f"restart failed: {name}")
    return p, port


# ---------- level runner ----------

async def ensure_groups(n):
    c = await open_conn()
    for i in range(n):
        body = json.dumps({"groupId": f"glt-{i}"}).encode()
        try:
            await c.request("POST /api/v1/groups/register HTTP/1.1",
                            hdrs(len(body)), body, timeout=10)
        except Exception:
            c.w.close()
            c = await open_conn()
    c.w.close()


def pct(xs, p):
    if not xs:
        return None
    return round(xs[min(len(xs) - 1, int(len(xs) * p / 100))], 2)


async def run_level(port, server_pid, U):
    global PORT
    PORT = port
    stop = asyncio.Event()
    S = {"lat": [], "reqs": 0, "ops_sent": 0, "joined": 0, "timeout": 0,
         "connerr": 0, "emfile": 0, "ramp_err": 0, "sse_broken": 0,
         "server_died_at": None}
    P = {"wakes": [], "last_push": 0.0, "pusher_err": 0}
    n_groups = max(1, U // 50)
    await ensure_groups(n_groups)
    ramping = set()
    live = set()  # task refs, self-removed on done (caps retained memory)

    def _drop(t):
        live.discard(t)

    t_ramp = time.monotonic()
    for w0 in range(0, U, WAVE):
        if await alive(port) is False:  # None = generator out of FDs: keep going
            S["server_died_at"] = U - w0
            break
        cnt = min(WAVE, U - w0)
        t_next = time.monotonic()
        for i in range(cnt):
            uid = w0 + i
            if RAMP_RATE:
                t_next = max(t_next + 1.0 / RAMP_RATE, time.monotonic())
                delay = t_next - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
            ramping.add(uid)
            t = asyncio.create_task(
                user_task(uid, f"glt-{uid // 50}", stop, S, ramping))
            live.add(t)
            t.add_done_callback(_drop)
        deadline = time.monotonic() + RAMP_TIMEOUT
        while ramping and time.monotonic() < deadline:
            await asyncio.sleep(1)
    ramp_ms = (time.monotonic() - t_ramp) * 1000
    probes = [asyncio.create_task(probe_pusher(stop, P))]
    probes += [asyncio.create_task(probe_watcher(stop, P))
               for _ in range(PROBE_WATCHERS)]
    steady_s = 10 if S["server_died_at"] else STEADY.get(U, 90)
    samples, stop_s = [], asyncio.Event()
    sampler = asyncio.create_task(sample_server(server_pid, stop_s, samples))
    S["lat"] = []; S["reqs"] = 0  # steady-window-only metrics (ramp ticks excluded)
    await asyncio.sleep(steady_s)
    stop.set(); stop_s.set()
    for t in list(live):
        if not t.done():
            t.cancel()
    await asyncio.wait(list(live) + probes, timeout=6)
    for t in list(live) + probes:
        if not t.done():
            t.cancel()
    await asyncio.wait(list(live) + probes, timeout=3)
    lat = sorted(S["lat"])
    alive_samples = [s for s in samples if s["srv_rss_mb"] is not None]
    return {
        "users_requested": U,
        "users_joined": S["joined"],
        "ramp_ms": round(ramp_ms, 0),
        "steady_s": steady_s,
        "sync_p50": pct(lat, 50), "sync_p95": pct(lat, 95),
        "sync_p99": pct(lat, 99), "sync_max": round(lat[-1], 1) if lat else None,
        "throughput_rps": round(S["reqs"] / steady_s, 1),
        "timeout": S["timeout"], "connerr": S["connerr"],
        "emfile": S["emfile"], "ramp_err": S["ramp_err"],
        "sse_broken": S["sse_broken"],
        "server_died_at": S["server_died_at"],
        "wake_p50": pct(P["wakes"], 50), "wake_p95": pct(P["wakes"], 95),
        "wake_n": len(P["wakes"]), "pusher_err": P["pusher_err"],
        "server_rss_mb": max((s["srv_rss_mb"] for s in alive_samples), default=None),
        "server_cpu_pct": round(sum(s["srv_cpu_pct"] for s in alive_samples
                                    if s["srv_cpu_pct"] is not None)
                                / max(1, len([s for s in alive_samples
                                              if s["srv_cpu_pct"] is not None])), 1),
        "gen_rss_mb": max((s["gen_rss_mb"] for s in alive_samples), default=None),
        "ops_sent": S["ops_sent"],
    }


async def main():
    base_py, base_rust, py, ru = net_bench.setup()
    p_py = int(base_py.rsplit(":", 1)[1])
    p_rust = int(base_rust.rsplit(":", 1)[1])
    net_bench.wait_up(base_py)
    net_bench.wait_up(base_rust)
    to_cgroup(py.pid)
    to_cgroup(ru.pid)
    register(base_py, "g-probe")
    register(base_rust, "g-probe")
    dbs = {"python": net_bench.DB_PY, "rust": net_bench.DB_RUST}
    rust_h, py_h = {"p": ru, "port": p_rust}, {"p": py, "port": p_py}
    results = {"python": {}, "rust": {}}
    try:
        for U in LEVELS:
            print(f"=== level {U} ===", flush=True)
            for name, holder in (("rust", rust_h), ("python", py_h)):
                if name == "python" and RUST_ONLY:
                    continue
                t0 = time.monotonic()
                if await alive(holder["port"]) is False:
                    print(f"  {name}: server dead, restarting", flush=True)
                    holder["p"], holder["port"] = await restart(
                        name, holder["p"], dbs[name])
                    to_cgroup(holder["p"].pid)
                res = await run_level(holder["port"], holder["p"].pid, U)
                res["wall_s"] = round(time.monotonic() - t0, 1)
                results[name][str(U)] = res
                print(f"  {name}: joined={res['users_joined']}/{U} "
                      f"p50={res['sync_p50']}ms p95={res['sync_p95']}ms "
                      f"p99={res['sync_p99']}ms rps={res['throughput_rps']} "
                      f"err={res['timeout'] + res['connerr']} "
                      f"emfile={res['emfile']} wake_p50={res['wake_p50']}ms "
                      f"rss={res['server_rss_mb']}MB cpu={res['server_cpu_pct']}%",
                      flush=True)
    finally:
        for h in (rust_h, py_h):
            h["p"].terminate()
        await asyncio.sleep(1.5)
        for h in (rust_h, py_h):
            if h["p"].poll() is None:
                h["p"].kill()
    with open("/tmp/loadtest.json", "w") as f:
        json.dump(results, f, indent=1)
    print("wrote /tmp/loadtest.json", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
