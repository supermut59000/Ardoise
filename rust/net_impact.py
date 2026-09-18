#!/usr/bin/env python3
"""Impact of realistic network conditions on the Ardoise sync contract.

No tc/netem (no sudo here): each backend sits behind a rootless userspace
TCP proxy (netem.py) that injects delay, jitter, loss (emulated as TCP
retransmission timeouts) and bandwidth limits, in both directions.

Profiles (one-way):
  wifi   15 ms delay, 5 ms jitter, 1% loss
  4g     60 ms delay, 15 ms jitter, 0% loss, 4 Mbps
  flaky  40 ms delay, 20 ms jitter, 8% loss

Measured per backend, per profile (median of 7):
  sync_idle, sync_1op
  e2e_wake_plus_sync_ms  : push + SSE wake + /sync through the proxy
  join_10k_ms            : full-group pull (~10k ops, 1.7 MB raw) — 4g only
Writes /tmp/net-impact.json, prints the tables.
"""
import gzip, http.client as httpc, json, os, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import net_bench  # noqa: E402
from net_bench import KEY, req  # noqa: E402
from parity_check import free_port  # noqa: E402

PROFILES = {
    "wifi":  dict(delay=15.0, jitter=5.0, loss=1.0, rto=300.0, mbps=0.0),
    "4g":    dict(delay=60.0, jitter=15.0, loss=0.0, rto=300.0, mbps=4.0),
    "flaky": dict(delay=40.0, jitter=20.0, loss=8.0, rto=300.0, mbps=0.0),
}
REPS = 7
HERE = os.path.dirname(os.path.abspath(__file__))


def start_proxy(target_base, prof):
    port = urllib.request.urlsplit(target_base).port
    p = free_port()
    a = PROFILES[prof]
    prox = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "netem.py"),
         "--listen", str(p), "--target", f"127.0.0.1:{port}",
         "--delay-ms", str(a["delay"]), "--jitter-ms", str(a["jitter"]),
         "--loss-pct", str(a["loss"]), "--rto-ms", str(a["rto"]),
         "--mbps", str(a["mbps"])],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    time.sleep(0.3)
    return f"http://127.0.0.1:{p}", prox


def stop_proxy(prox):
    try:
        prox.terminate()
        prox.wait(timeout=3)
    except Exception:
        try:
            prox.kill()
        except Exception:
            pass


def wait_up(base, tries=60):
    for _ in range(tries):
        try:
            urllib.request.urlopen(base + "/api/v1/system/ping", timeout=2).read()
            return
        except Exception:
            time.sleep(0.3)
    raise SystemExit(f"server not reachable through proxy: {base}")


def read_until(resp, buf, needle):
    while buf.find(needle) < 0:
        chunk = resp.read(1)
        if not chunk:
            raise SystemExit("SSE stream closed by server/proxy")
        buf.extend(chunk)


def read_frame(resp, buf):
    """Consume one full 'event: op' frame. The buffer is trimmed after each
    frame: if it accumulated, the next rep would match stale bytes and the
    measured latency would be a fraction of a chunk, not a wake."""
    while True:
        j = buf.find(b"event: op")
        if j >= 0:
            k = buf.find(b"\n\n", j)
            if k >= 0:
                del buf[k + 2:]
                return
        chunk = resp.read(1)
        if not chunk:
            raise SystemExit("SSE stream closed by server/proxy")
        buf.extend(chunk)


def profile_bench(base_direct, base, cursor, i, prof):
    out = {}
    for _ in range(2):  # warm-up
        net_bench.sync(base, cursor, 0, i)
    ts = [net_bench.sync(base, cursor, 0, i)[0] for _ in range(REPS)]
    out["sync_idle"] = round(sorted(ts)[len(ts) // 2], 2)

    for _ in range(2):
        _, cursor = net_bench.sync(base, cursor, 1, i)
        i += 1
    ts = []
    for _ in range(REPS):
        ms, cursor = net_bench.sync(base, cursor, 1, i)
        i += 1
        ts.append(ms)
    out["sync_1op"] = round(sorted(ts)[len(ts) // 2], 2)

    # SSE wake + /sync through the proxy: the realistic peer-up-to-date path.
    hp = urllib.request.urlsplit(base).netloc
    conn = httpc.HTTPConnection(*hp.split(":"), timeout=60)
    conn.request("GET", f"/api/v1/groups/{net_bench.GID}/events",
                 headers={"X-API-Key": KEY, "Accept": "text/event-stream"})
    resp = conn.getresponse()
    assert resp.status == 200, resp.status
    buf = bytearray()
    read_until(resp, buf, b": connected")
    del buf[:]
    for _ in range(2):  # warm-up
        net_bench.sync(base_direct, cursor, 1, i)
        i += 1
        cursor += 1
        read_frame(resp, buf)
    e2e = []
    for _ in range(REPS):
        t0 = time.monotonic()
        net_bench.sync(base_direct, cursor, 1, i)
        i += 1
        cursor += 1
        read_frame(resp, buf)
        r2 = req("POST", f"{base}/api/v1/groups/{net_bench.GID}/sync",
                 {"ops": [], "since": cursor - 1, "reseed": False})
        assert r2["cursor"] == cursor
        e2e.append((time.monotonic() - t0) * 1000)
    out["e2e_wake_plus_sync_ms"] = round(sorted(e2e)[len(e2e) // 2], 2)
    conn.close()

    # Full-group join through the bandwidth-limited proxy (4g only):
    # 10k ops is 1.7 MB raw; 1.7 MB at 4 Mbps is ~3.4 s of pure pacing.
    if prof == "4g":
        t0 = time.monotonic()
        r = urllib.request.Request(
            base + "/api/v1/groups/" + net_bench.GID + "/ops?since=0",
            headers={"X-API-Key": KEY})
        with urllib.request.urlopen(r, timeout=300) as resp:
            body = resp.read()
        out["join_10k_ms"] = round((time.monotonic() - t0) * 1000, 1)
        out["join_10k_raw_bytes"] = len(body)
        out["join_10k_gzip5_bytes"] = len(gzip.compress(body, 5))
    return out, cursor, i


def main():
    base_py, base_rust, py, ru = net_bench.setup()
    proxies = []
    try:
        net_bench.wait_up(base_py)
        net_bench.wait_up(base_rust)
        print("direct up", flush=True)
        t0 = time.monotonic()
        cursor_py = net_bench.seed(base_py)
        cursor_ru = net_bench.seed(base_rust)
        print(f"seeded {cursor_py} + {cursor_ru} ops "
              f"in {(time.monotonic() - t0) / 60:.1f} min", flush=True)

        i = net_bench.N_SEED
        results = {"python": {}, "rust": {}}
        for prof in PROFILES:
            print(f"--- profile {prof}", flush=True)
            base_py_x, prox_py = start_proxy(base_py, prof)
            base_ru_x, prox_ru = start_proxy(base_rust, prof)
            proxies.extend([prox_py, prox_ru])
            wait_up(base_py_x)
            wait_up(base_ru_x)
            print(f"  proxy up: {prof}", flush=True)
            out_py, cursor_py, i = profile_bench(
                base_py, base_py_x, cursor_py, i, prof)
            out_ru, cursor_ru, i = profile_bench(
                base_rust, base_ru_x, cursor_ru, i, prof)
            results["python"][prof] = out_py
            results["rust"][prof] = out_ru
            print(f"  py  {out_py}", flush=True)
            print(f"  ru  {out_ru}", flush=True)
            stop_proxy(prox_py)
            stop_proxy(prox_ru)
    finally:
        for prox in proxies:
            stop_proxy(prox)
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
    with open("/tmp/net-impact.json", "w") as f:
        json.dump(results, f, indent=2)
    print("wrote /tmp/net-impact.json")


if __name__ == "__main__":
    main()
