#!/usr/bin/env python3
"""netem.py — rootless TCP proxy that injects delay, jitter, loss and bandwidth.

No sudo, no tc: the classic software substitute. Both directions are shaped
with the same profile. "Loss" is emulated as a stall of --rto-ms: a userspace
byte-stream proxy cannot drop bytes (that corrupts the stream, it is not
network loss); real loss shows up to the app as TCP retransmission timeouts,
i.e. as delay — which is what this emulates.

Usage:
  python netem.py --listen 9400 --target 127.0.0.1:8001 \
      --delay-ms 30 --jitter-ms 10 --loss-pct 5 --mbps 4 --rto-ms 300
"""
import argparse, asyncio, random, sys


async def pump(reader, writer, delay, jitter, loss, rto, rate, tag):
    """Forward bytes with the shaped profile. Does NOT close the writer:
    the owner (handle) closes both ends once both pumps are done, so a
    fast-finishing client half can never send an early FIN to the server
    and abort an in-flight response."""
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                return  # peer closed its side (normal end of that direction)
            if random.random() < loss:
                await asyncio.sleep(rto)  # emulated TCP retransmission timeout
            await asyncio.sleep(delay + random.uniform(0, jitter))
            if rate:
                await asyncio.sleep(len(chunk) / rate)  # crude per-chunk pacing
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError):
        pass  # peer went away: the other pump will EOF shortly
    except Exception as e:  # visible, not swallowed: silent pumps are how
        print(f"netem {tag}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        raise


async def handle(client_r, client_w, target_host, target_port, a):
    try:
        tr, tw = await asyncio.open_connection(target_host, target_port)
    except OSError:
        client_w.close()
        return
    d = a.delay_ms / 1000
    j = a.jitter_ms / 1000
    l = a.loss_pct / 100
    rto = a.rto_ms / 1000
    r = a.mbps * 1e6 / 8 or None
    await asyncio.gather(
        pump(client_r, tw, d, j, l, rto, r, "c2s"),
        pump(tr, client_w, d, j, l, rto, r, "s2c"),
    )
    for w in (client_w, tw):  # the two writers; readers follow the transports
        w.close()
        try:
            await w.wait_closed()
        except Exception:
            pass


async def main(a):
    server = await asyncio.start_server(
        lambda r, w: handle(r, w, a.target, a.port, a), "127.0.0.1", a.listen)
    print(f"netem: :{a.listen} -> {a.target}:{a.port} "
          f"delay={a.delay_ms}ms jitter={a.jitter_ms}ms loss={a.loss_pct}% (rto={a.rto_ms}ms) mbps={a.mbps}",
          flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--listen", type=int, required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--delay-ms", type=float, default=0)
    p.add_argument("--jitter-ms", type=float, default=0)
    p.add_argument("--loss-pct", type=float, default=0)
    p.add_argument("--rto-ms", type=float, default=300)
    p.add_argument("--mbps", type=float, default=0)
    args = p.parse_args()
    host, _, port = args.target.partition(":")
    args.target, args.port = host, int(port or 80)
    asyncio.run(main(args))
