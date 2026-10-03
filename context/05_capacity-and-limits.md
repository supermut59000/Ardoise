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

## Constrained-resources capacity (cgroup tests, 2026-09-26)

Same box, server confined via cgroup v2 to **1 CPU (`cpu.max 100000 100000`)**
+ a RAM cap (`memory.max`, `memory.swap.max=0`); generator unrestricted.
Write profile = real world, not the synthetic storm: 1000 ops/year/group,
`WRITE_PROB≈1.6e-5` (≈0.2 ops/s at 12k users vs ~1 700 ops/s in the storm).
Each user = 1 HTTP keep-alive + 1 SSE (2 sockets; the single-host generator
caps around ~14k concurrent users = 28k ephemeral ports).

Joins are staggered (`RAMP_RATE=100` users/s): a full-blast 12k simultaneous
cold join is a harness artifact, see the group-commit section below.

| Config | 6k | 10k | 12k | 13k |
|---|---|---|---|---|
| 1 core + 1 GB | ✅ p50 0.92 ms, RSS 568 MB, CPU 25 % | ❌ **OOM kill at 8 693 users** | — | — |
| 1 core + 2 GB | — | ✅ p50 0.92 ms, RSS 857 MB, CPU 42 % | ✅ p50 0.94 ms, RSS 1.13 GB, CPU 48 % | ✅ p50 0.91 ms, RSS 1.22 GB, CPU 51 % |

All runs: p95 < 3 ms, p99 < 115 ms, 0 protocol errors, SSE wake p50 1–4 ms.
RAM grows ~92 KB/user RSS (measured 12k→13k: 92.6 KB/user). Measured
breakdown at 10k users (cgroup `memory.stat` + `smaps_rollup`):
~89 KB process heap per user — real per-user allocations (hyper/axum
connection state, tokio tasks, SSE receivers), **not** glibc
fragmentation (`MALLOC_ARENA_MAX=2` changes only 1.6 KB/user),
~8 KB kernel socket memory (2 sockets per user, slab), ~2.5 KB page
cache (tmpfs DB). The 24 MB idle baseline is the 12 tokio worker-thread
stacks (2 MB each) + base. 2 GB + 1 core is
bounded by RAM first (~17k extrapolated), CPU second (51 % at 13k).
Per 1 000 users: 50 sync req/s, ~0.03 real writes/s — polling + SSE dominate,
writes are negligible.

**Bug found by these tests (fixed):** `with_reader` popped a connection out
of the pool and pushed it back after the query. A task cancelled mid-query
(client disconnect) never pushed back; a mass of simultaneous disconnects
(20k sockets at a level transition) drained the 8-connection pool →
`expect` panic → server death at 12k users. Fixed by replacing pop/push
with 8 fixed slots, each behind its own `tokio::sync::Mutex`: the guard is
released by `Drop` even on cancellation, a drained pool is no longer
reachable. Verified: rebuild, 14/14 tests, FULL PARITY, 12k/13k constrained
runs clean.

## Group commit (writer batching, 2026-09-26)

**Why:** every write was its own transaction + commit + fsync. In a burst
(870 write requests/s at 12k storm users) that is ~870 commits/s of disk
wear; the real profile is ~0.2 writes/s, where the volume already
matters little. Goal: cap commit rate at 10/s under bursts, unchanged at
idle.

**How:** a dedicated batcher task owns the writer `Connection` (it is never
shared — no lock). All write paths (`server_generation`, `register_group`,
`push_ops`, `sync_ops`, `upsert_sub`, `delete_sub`) queue a closure via an
`mpsc` channel and await an oneshot reply. The batcher:

- drains what is already queued (cap `FLUSH_N = 100` writes per batch);
- **solo check:** a write arriving to an empty queue waits `GRACE_MS`
  (50 ms) for a following write before committing alone. Without this,
  a steady 93 writes/s streams through as one commit per write (each
  arrival finds an empty queue — measured 97.6 commits/s, i.e. no
  batching). With it, steady rates of 20 writes/s and up form batches;
  a truly idle write (~0.2/s in the real profile) pays 50 ms, invisible
  at the 20 s cadence;
- a **concurrent** burst waits out the 100 ms window (`FLUSH_MS`) so it
  lands in one commit;
- applies the batch in one transaction, one commit. A failed statement
  aborts the batch: ROLLBACK, every job in it gets an error (all writes
  are idempotent, clients retry).

**Crash safety (non-negotiable, kept):** the reply lands **after** the
commit. A crash inside the window ACKs nothing; the client re-pushes and
the `op_id` unique index makes the replay a no-op.

**Latency cost:** a solo write is ACKed up to 50 ms (grace) after
arrival; a burst up to 150 ms (grace + window). Both invisible against
the clients' 20 s sync cadence. SSE publish happens after the write
returns, so events still follow the commit.

**Measured (same day):** 6k-user write storm (31 % of syncs carry writes
≈ 93 write requests/s sustained), DB on btrfs, 1 core + 2 GB, staggered
joins (`RAMP_RATE=50`):

| | per-write commit (before) | group commit (after) |
|---|---|---|
| commits = fsyncs/s | ~93 (1 per write) | **8.5** (100 ms window cap) |
| block writes | 2.4–3.1 MiB/5 s | 1.3–1.9 MiB/5 s (−43 %) |
| 6k joined / errors | 6 000 / 0 | 6 000 / 0 |
| sync p50 (31 % of syncs carry writes) | 2.2 ms | 2.3 ms (read-only syncs unchanged) |
| sync p95 | 23.6 ms | 112.6 ms (write-carrying syncs pay the window) |
| CPU | 74.6 % | 66.8 % |

The byte reduction is smaller than the fsync reduction because the byte
volume is dominated by op data (page-cache writeback); the wear-relevant
metric is fsync / journal commits: **11× fewer**. The commit count is
exposed in `/health` (`commits`) since this change. No regression in the
real profile: 12k / 13k clean (12 000/12 000 and 13 000/13 000 joined,
0 errors, 1 121–1 144 MB, CPU 49–56 %).

Two bugs the first measurements caught, both fixed before the numbers
above:

1. **Solo-flush leak:** without the grace, a steady 93 writes/s streamed
   through as one commit per write (each arrival finds an empty queue) —
   measured 97.6 commits/s, i.e. zero batching.
2. **Reads misrouted to the writer:** `server_generation()` (called by
   every `/sync`) went through `with_writer`, so the grace added 50 ms to
   every read-only sync (12k p50 went 1.2 ms → 57 ms). Fixed by seeding
   `server_meta.generation` once at `open()` and reading it on the
   reader pool (writer path remains as fallback for pre-seed DBs).
   After the fix, only write-carrying syncs pay the window (p95 112 ms in
   the 31 %-write storm; read-only syncs stay at p50 ~2 ms).

**Harness finding (not a server limit, not a regression):**
`RAMP_RATE=0` = 12k users connecting + SSE + first sync **all at t=0**.
A 1-core server cannot complete those joins inside the harness' 15 s sync
timeout: ~2k join, ~10k time out — **identically on the pre-batching
binary** (1 664 vs 1 786 of 12 000 joined, server CPU ~18 %: the server is
idle-waiting, not saturated). Staggered joins (`RAMP_RATE=100`) pass
12k–13k clean on both binaries (12 000/12 000, 0 ramp errors). Real
onboarding is staggered; the t=0 blast is a synthetic artifact. If a real
deployment ever joins thousands of clients in one instant, the fix is
client-side join jitter, not server capacity.

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

## Small box: 1 core + 1 GB, summer profile (2026-09-26)

Target deployment: a very constrained box (Raspberry Pi 3B+ class, 1 core +
1 GB reserved for the app). Target activity profile: summer, 5–8
ops/day/group, 80 % of the day's ops in the 14h–22h window (8 h), reads ≈
10× writes.

**Write rate is not the sizing dimension.** Worst case (1 group per user,
8k users): 8 ops/day × 0.8 ÷ 8 h = 0.8 ops/h/group → ~1.8 ops/s at the
peak. Group commit turns that into ≤10 fsync/s (measured 8.5 commits/s
under a 93 writes/s burst). Writer capacity is ~1 000 ops/s: 3–4 orders of
magnitude of headroom. Reads ×10 → ~18/s ≈ 9 % of one core (0.5 ms
lookup). The real per-user cost is the polling baseline: 1 sync/20 s + 1
SSE = 2 sockets + ~93 KB RAM (breakdown above).

| Budget | Concurrent users | Notes |
|---|---|---|
| 1 core + 1 GB, x86 (measured, cgroup) | **~8 000** | OOM kill at 8 693 (table above); CPU ~35 % (interpolated 6k→10k) → RAM binds, not the core |
| Pi 3B+ (1 core + 1 GB, extrapolated) | **~5–8k** | ARM A53 ≈ 0.35–0.5× an x86 core, ±50 %. A real 3B+ has 4 cores, but at 1 GB the OOM hits first, so the core count does not change the number |
| 1 core + 2 GB (measured / extrapolated) | ~13k clean / ~15–17k | the only upgrade that pays at 1 core: 2 GB ≈ 2× users (e.g. Pi 4 2 GB) |

**Daily / monthly sizing.** Daily users = concurrent ÷ c, where c = share
of the fleet connected at the 14h–22h peak — the only number only the
operator knows; calibrate on real data (apps open at a given afternoon hour
÷ total fleet).

| c | 1 core + 1 GB (8k) | Pi 3B+ (5–8k) |
|---|---|---|
| 30 % (very synchronized fleet) | ~27k | 17–27k |
| **10 % (reference: ~40 min presence/day spread over 8 h)** | **~80k** | **50–80k** |
| 5 % (spread out) | ~160k | 100–160k |

Monthly (users active over the month) ≈ daily × 30 ÷ active-days-per-user;
at 10 active days/user that is ≈ 3× daily (fleet estimate,
usage-dependent — not a server limit).

**Deployment on 1 core + 1 GB** — no code or concurrency changes needed:
- `LimitNOFILE=65536` in the service unit (default 1024 FDs caps at ~500
  users, far before RAM). The only config line that matters.
- No tokio worker tuning: M:N scheduler, 1 worker per core by default; the
  measured 1c+1GB run carried ~17k sockets on 1 worker.
- No `READERS` change: the 8 slots run at ~15 % at 8k users; more slots on
  a single core adds mutex contention with no parallelism gain (raise it
  only on multi-core boxes, see below).
- Group commit defaults are fine (≤10 fsync/s at this load); SD card A2
  recommended.
- Validate on site: `rust/loadtest.py` from a second host, `RAMP_RATE=100`,
  `LEVELS=1000,3000,5000,8000` (~1 h) turns the extrapolation into a number.

## Architectural ceilings (walls, in order of height)

Three stacked choices, from fundamental to arbitrary:

1. **SQLite single writer** (WAL: N readers + 1 writer) — physical to
   SQLite, deliberate (D32). Not reached at real write rates (≤300 ops/s
   at 1 M daily users vs ~1 000 ops/s capacity); group commit hides it
   (≤10 fsync/s).
2. **`READERS = 8`** (`rust/src/db.rs:61`) — the practical wall, and the
   only arbitrary one. A steady `/sync` takes the read pool **3 times**
   (`get_group` + `pull` + `server_generation`); each slot serves ~1 000–
   1 500 q/s (sub-ms indexed lookups + mutex). 8 slots × ~1 200 ÷ 3 ≈
   3 200 syncs/s ≈ **50–100k concurrent** (extrapolated, 12-core box).
   Beyond the slots, adding cores does nothing — a vertical choke on
   horizontal hardware. One-line fix (`READERS = 64`) moves the wall to the
   RAM ceiling (~200k on the 30 GB box). Invisible on a 1-core box: the RAM
   wall hits at ~8k first.
3. **Single process** — 93 KB RAM/user (measured) → ~200k concurrent on the
   30 GB box, and one point of failure (crash drops all SSE; clients
   reconnect, the log is reconstructible — D32). Beyond one process: shard
   by group — the sync contract is already per-group (the URL carries the
   group id), so N instances × N files routed by group id. Nothing to
   rewrite.

Contrast: the Python ~15-SSE wall is a real bug (synchronous SQLAlchemy in
the event loop, pool 5+10 pinned, 16th checkout freezes the loop 30 s).
The Rust walls are design ceilings with a designed exit: #2 is one
constant, #3 is sharding.

**Client-side lever (done 2026-10-03, fiche 07 §7):** the frontend now
holds ONE SSE stream per user for all shared groups
(`GET /groups/events?groups=a,b,c`, wake frame carries the group id, 50
groups cap; Python fallback to per-group streams on 404). Per-user cost is
G x (1 stream + 20 s poll) reduced to 1 stream + 20 s poll: a fleet
averaging 2 groups per user halves per-user RAM (the 93 KB/socket unit of
section "Small box"), roughly doubling the 1 GB ceiling for such fleets.
