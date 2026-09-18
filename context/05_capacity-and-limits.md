# 05 - Capacity, performance and limits (measured)

Measured 2026-07-14 on the dev machine (loopback, Docker stack, MariaDB 11.2),
with WORST-CASE ops: expense create, 5-member split, long description, emoji.
Typical ops (2-3 members, short description) are ~30% smaller. Method: 10 000
ops pushed through the real API in client-sized batches, InnoDB stats from
information_schema, fold timed in vitest. Bench data deleted afterwards.

## Storage per operation

| What | Measured |
|---|---|
| One op on the wire (JSON) | ~920 bytes |
| One op on disk in MariaDB (data + indexes) | ~1.5 KB |
| 1 000 ops | ~1.5 MB |
| 10 000 ops | ~15 MB |
| 100 000 ops | ~150 MB |

Growth model: a very active group produces ~1 000 ops/year. Ten groups for
five years is ~50 000 ops, ~75 MB. Storage is a non-issue. The phone keeps the
same log in IndexedDB at a similar size (also a non-issue against quotas).

## Sync timings

Since 2026-09-18 the client uses ONE `POST /sync` round trip (push+pull
combined) and a live SSE wake-up stream (`/events`): a peer change reaches
the other device in one wake frame + one `/sync`, and the 20 s poll is now
only the fallback. `POST /sync` costs ≈ push + pull in the same request.

**New contract, measured 2026-09-18** (`rust/net_bench.py`, loopback,
median of 7, 10 000-op group, both backends on SQLite):

| Scenario | Python + SQLite | Rust + SQLite | ratio |
|---|---|---|---|
| Idle sync (the every-20 s fallback poll) | 6.8 ms | 0.57 ms | 11.9× |
| Daily change, 1 op — one request instead of two | 7.6 ms | 0.68 ms | 11.2× |
| 3 ops, one request | 8.6 ms | 0.60 ms | 14.3× |
| 500-op batch (pull included) | 85 ms | 8.5 ms | 10.1× |
| 10 000-op catch-up (20 × `/sync` of 500) | 1.17 s | 0.19 s | 6.1× |
| 10 000-op fresh-join pull | 2.7 s, 9.4 MB raw → 0.80 MB gzip-5 | 0.50 s, same sizes | 5.4× |
| **SSE wake: push completes → frame received** | 5.1 ms | 0.71 ms | 7.1× |
| **E2E: peer up-to-date (wake + its `/sync`)** | **8.6 ms** | **1.2 ms** | 7.0× |

That last row is the point: a change reaches the other device in single-digit
milliseconds instead of up to 20 s (worst case of the old poll). The old
contract's request cost on loopback was comparable (6.7 ms for push+pull);
what the new contract kills is the *wait*, not the bytes.

**Old contract (pre-2026-09-18, Python + MariaDB, 2026-07-14)** — kept for
the reference stack; superseded by the table above:

| Scenario | Measured |
|---|---|
| Up-to-date pull (the every-20s poll) | 13 ms |
| Daily push (1-3 ops, one batch) | 20-50 ms |
| 500-op push batch | ~175 ms |
| 10 000-op catch-up push (20 batches) | 3.5 s total |
| Fresh join of a 10 000-op group | one 8.6 MB response, 1.8 s (nginx gzips JSON ~5x, so ~1.5-2 MB over the air) |

## Client-side fold (recomputed per change while a group is open)

Desktop Node timings; multiply by ~3-5 for a mid-range phone:

| Group log size | foldOps | balances + transfers |
|---|---|---|
| 1 000 ops | 2 ms | 29 ms |
| 5 000 ops | 9 ms | 41 ms |
| 10 000 ops | 13 ms | 58 ms |
| 20 000 ops | 50 ms | 94 ms |

Conclusion: instant for decades of normal use. If a group ever crosses
~20-30 000 ops, revisit D14 (cache the folded state); not before.

## Hard limits baked into the code

| Limit | Value | Where |
|---|---|---|
| Push batch size | 500 ops (~460 KB worst case) | `PUSH_BATCH`, sync/engine.ts |
| nginx request body cap | 10 MB | frontend-react/nginx.conf |
| Sync request timeout | 15 s | sync/client.ts |
| Notification silence threshold | > 50 accepted ops, or any `reseed`-flagged push (heal/catch-up, not activity) | `NOTIFY_MAX_BATCH` + `reseed`, push_service.py / ops.py |
| Push notification TTL | 1 h | push_service.py |
| String columns | group/entity ids 36, endpoint 500 | models |

## RAM footprint (measured idle, docker stats)

| Configuration | RSS |
|---|---|
| MariaDB 11.2 defaults | 201 MB |
| MariaDB tuned (`--innodb-buffer-pool-size=64M --performance-schema=OFF --max-connections=40`) | 78 MB |

The tuned figure is Postgres-class, so migrating engines buys nothing here
(see D32). The flags are APPLIED as the mariadb `command:` in docker-compose
since 2026-07-15 (verified healthy at 77 MB through the compose healthcheck).
64M of buffer pool comfortably holds years of ops (see storage table).
Backend + frontend containers are ~100 MB together.

## Append-only consequences (know these)

- The log only grows: deletes are tombstones, space is never reclaimed.
  "Quitter le groupe" frees the phone only; the server keeps everything.
  Resetting a group = export JSON + start a fresh group.
- Local-only (never shared) groups exist on ONE phone, no server copy, no
  self-heal. Share them or export occasionally.
- The server password, per-group identity, theme and notification toggle live
  in each browser's localStorage: not in exports, re-entered on a new device.
