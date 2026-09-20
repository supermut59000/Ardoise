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

## Concurrent users (2026-09-19, `rust/loadtest.py`, 12-core / 30 GB box, loopback)

Method: one generator process; U users, each = HTTP keep-alive + SSE
stream; ramp (full blast or rate-limited `RAMP_RATE` users/s), then a
steady window where every user syncs every 18–22 s and a probe group
measures SSE wake (push → frame). SQLite, fresh DB.

**Python (uvicorn): wall at ~15 SSE streams, no scaling curve.**
`group_events` is `async def` but runs synchronous SQLAlchemy on the event
loop; the first 15 SSE connections pin the pool (5 + 10) and the 16th
checkout blocks the loop up to 30 s — the whole server stops answering.
0–5 of U joined at every level, 100 → 1 000 000, burst or gentle.

**Rust (axum): clean to 10k, caps at ~14k concurrent users.**

| Level (ramp) | joined | sync p50 / p99 | RSS | CPU | wake p50 |
|---|---|---|---|---|---|
| 10k (2 500 u/s) | 10 000 / 10k | 0.87 ms / 153 ms | 882 MB | 36 % | 0.4 ms |
| 100k (500 u/s) | 14 114 / 100k | 0.84 ms / 81 ms | 1 441 MB | 50 % | — ¹ |
| 1 000 000 (2 500 u/s) | 14 114 / 1M | 17.6 ms / 116 ms ² | 1 687 MB | 55 % | — ¹ |
| 200k (500 u/s) | 14 114 / 200k | unresponsive mid-level ³ | — | — | — ¹ |

¹ probe SSE stopped delivering at 100k+ (likely collateral of the same
   stall; not independently verified — follow up before quoting wake at
   scale)
² steady-window metrics predate the steady-only counter fix; include ramp
   ticks of long-lived users
³ server stopped answering at ~150k users (liveness break); process gone
   by steady sampling; no panic logged, no OOM

- **Burst mode is a TCP artifact, not an app limit.** 10k simultaneous SYNs
  get only ~4.4k through (accept backlog 1024; the kernel drops the rest
  and retransmissions outlive the 10 s connect timeout); 100k SYNs → 0%.
  Same 10k with a governed 2 500 u/s ramp: 10 000 / 10 000, zero errors.
- **The ~14k cap is the SQLite single-writer path, not the machine.** One
  connection behind a `std::sync::Mutex` (WAL, `synchronous=NORMAL`),
  locked inside async handlers: around 14k concurrent users the
  join/sync/keepalive demand saturates the writer, tokio worker threads
  block on the mutex, new joins exceed the 15 s client timeout, and at
  200k the server stops answering. Nothing else is close at the cap: RSS
  1.4–1.7 GB of 30 GB (~88–100 KB/user), 28k of 524k FDs, ~50 % of one
  core.
- Steady-state cost per user: ~88–100 KB RSS; ~700 syncs/s aggregate for
  14k users at sub-millisecond p50 while the join queue is empty.

**After the storage-layer fix (2026-09-19): cap moves 14.1k → 56.3k, then
the single writer saturates under the synthetic write storm.**

Fix: `std::sync::Mutex` → `tokio::sync::Mutex` on the writer connection;
WAL read pool of 8 read-only connections (`with_reader`, slots run in
parallel); empty-ops `/sync` (69% of steady traffic) routed to the read
pool as a pure pull; `get_group`/`resolve_code`/`health`/`list_subs`/
`latest_field` on the read pool; `busy_timeout(5 s)` on every connection.
Writer still owns register/push/sync-with-ops/subscriptions. 14/14 unit
tests, full Python↔Rust parity (`rust/parity_check.py`).

| Level (ramp) | joined | sync p50 / p99 | RSS | CPU |
|---|---|---|---|---|
| 100k (500 u/s) | **56 263 / 100k** | 2.58 ms / 1 380 ms | 1 630 MB | 76 % of 1 core |

- At the cap, the writer — not the lock, not RAM, not CPU — is the wall
  under the **synthetic** storm (31% of users push 1–3 ops every 20 s):
  ~870 push tx/s at 56k, just past the single-writer capacity. Push syncs
  queue past the 15 s timeout (err ≈ every push sync in steady), pulls
  stay fine (p50 2.58 ms). Real-world write rate is ~1 000× lower
  (~1 000 ops/year/group), so at real load the writer is not the limit.
- Measured per-user RSS at 56k: ~29 KB (1.63 GB) — the earlier 88–100 KB
  estimate included the groups page cache; 200k users ≈ 6 GB, well under
  the 30 GB box.
- **Harness/machine wall found at 200k: client ephemeral port space.**
  `net.ipv4.ip_local_port_range = 32768–60999` = 28 232 ports; the 200k
  run held 28 197 ESTAB, then the generator got `EADDRNOTAVAIL` (errno 99)
  on new connects. One loopback generator on this host tops out at ~28k
  concurrent held connections (~64k with a widened port range). Multi-
  process generation on the same host does **not** help: FDs are
  per-process, ephemeral ports are per-host. A 200k+ user test needs a
  second generator machine (or a no-keep-alive generator churning ports
  with `tcp_tw_reuse`).

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
