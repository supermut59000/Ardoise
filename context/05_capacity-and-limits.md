# 05 - Capacity and limits (measured)

Loopback: 2026-09-18, `rust/net_bench.py` (median of 7, 10 000-op group, both
backends on SQLite). Degraded network: 2026-09-18, `rust/net_impact.py` behind a
rootless TCP proxy (`rust/netem.py`), profiles one-way, median of 7.
Storage/RAM history: 2026-07-14, Python + MariaDB 11.2, worst-case ops
(expense, 5-member split, long description, emoji; typical ops ~30% smaller).

## Sync — loopback (2026-09-18, `/sync` + SSE contract)

| Scenario | Python + SQLite | Rust + SQLite | ratio |
|---|---|---|---|
| Idle sync (every-20 s fallback poll) | 6.8 ms | 0.57 ms | 11.9× |
| Daily change, 1 op — one request instead of two | 7.6 ms | 0.68 ms | 11.2× |
| 3 ops, one request | 8.6 ms | 0.60 ms | 14.3× |
| 500-op batch (pull included) | 85 ms | 8.5 ms | 10.1× |
| 10 000-op catch-up (20 × `/sync` of 500) | 1.17 s | 0.19 s | 6.1× |
| Full-group join (53.5 k ops, 9.4 MB raw → 0.80 MB gzip-5) | 2.7 s | 0.50 s | 5.4× |
| SSE wake: push completes → frame received | 5.1 ms | 0.71 ms | 7.1× |
| **E2E: peer up-to-date (wake + its `/sync`)** | **8.6 ms** | **1.2 ms** | 7.0× |

Single-digit milliseconds instead of up to 20 s (worst case of the old poll):
what the new contract kills is the *wait*, not the bytes.

## Sync — degraded network (2026-09-18, proxy in both directions, median of 7)

| Profile (one-way) | Scenario | Python | Rust |
|---|---|---:|---:|
| wifi: 15 ms, 5 ms jitter, 1% loss | idle sync | 59 ms | 42 ms |
| | daily change, 1 op | 49 ms | 38 ms |
| | E2E peer up-to-date (wake + `/sync`) | 68 ms | 41 ms |
| 4g: 60 ms, 15 ms jitter, 4 Mbps | idle sync | 208 ms | 146 ms |
| | daily change, 1 op | 214 ms | 143 ms |
| | E2E peer up-to-date (wake + `/sync`) | 165 ms | 150 ms |
| | join a 10 000-op group (1.74 MB raw → 150 KB gzip-5) | 6.0 s | 5.6 s |
| flaky: 40 ms, 20 ms jitter, 8% loss | idle sync | 148 ms | 100 ms |
| | daily change, 1 op | 133 ms | 104 ms |
| | E2E peer up-to-date (wake + `/sync`) | 128 ms | 109 ms |

Loss is emulated as a 300 ms stall (an RTO): a userspace proxy cannot drop
bytes without corrupting the TCP stream, and real loss shows up to the app as
retransmission timeouts, i.e. delay. Under 4g the join is bandwidth-bound —
both backends land within 7% of each other; gzipped, the 150 KB body is
~0.3 s of pacing instead of 5.6-6.0 s. The app stays responsive in every
profile: ≤ ~0.2 s per change, ≤ ~6 s to join a 10 000-op group.

## Storage per operation (worst case, MariaDB)

| What | Measured |
|---|---|
| One op on the wire (JSON) | ~920 B |
| One op on disk (data + indexes) | ~1.5 KB |
| 10 000 ops | ~15 MB |
| 100 000 ops | ~150 MB |

A very active group produces ~1 000 ops/year — storage is a non-issue (the
phone keeps the same log in IndexedDB at a similar size).

## Client-side fold (recomputed per change while a group is open)

Desktop Node; multiply by ~3-5 for a mid-range phone.

| Group log | foldOps | balances + transfers |
|---|---|---|
| 1 000 ops | 2 ms | 29 ms |
| 10 000 ops | 13 ms | 58 ms |
| 20 000 ops | 50 ms | 94 ms |

Instant for decades of normal use; revisit D14 (cache folded state) only if a
group crosses ~20-30 000 ops.

## Hard limits baked into the code

| Limit | Value | Where |
|---|---|---|
| Push batch size | 500 ops (~460 KB worst case) | `PUSH_BATCH`, sync/engine.ts |
| nginx request body cap | 10 MB | frontend-react/nginx.conf |
| Sync request timeout | 15 s | sync/client.ts |
| Notification silence threshold | > 50 accepted ops, or any `reseed`-flagged push | `NOTIFY_MAX_BATCH` + `reseed`, push_service.py / ops.py |
| Push notification TTL | 1 h | push_service.py |
| String columns | group/entity ids 36, endpoint 500 | models |

## RAM footprint (idle, docker stats)

| Configuration | RSS |
|---|---|
| MariaDB defaults | 201 MB |
| MariaDB tuned (64 M buffer pool, perf schema off, 40 conns) — applied in compose since 2026-07-15 | 78 MB |
| Backend + frontend containers, together | ~100 MB |
| Rust single binary + SQLite (no containers) | 24.1 MB |

Append-only consequences (tombstones, local-only groups, per-browser
localStorage) are covered in [02](02_sync-and-offline.md) and
[03](03_decisions.md) — not repeated here.
