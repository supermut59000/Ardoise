# 08 - Small box: 1 core + 1 GB (measured 2026-09-26)

The constrained deployment profile, sized end to end. Target box:
Raspberry Pi 3B+ class, **1 core + 1 GB** reserved for the app. Target
activity profile: summer, 5-8 ops/day/group, 80 % of the day's ops in the
14h-22h window (8 h), reads = ~10x writes.

**Short answer:** ~8 000 concurrent users (x86, measured), ~5-8k on a real
Pi 3B+ (extrapolated, +/-50 %). RAM binds, not the core. The only
upgrade that pays at 1 core is 2 GB of RAM: ~2x users.

Per connected user: ~93 KB RAM, 2 sockets (HTTP keep-alive + 1 SSE stream
for all groups, since 2026-10-03, see [07](07_rust-optimizations.md) §7),
1 sync/20 s.

## Why the core is not the binding resource

Worst case (1 group per user, 8k users): 8 ops/day x 0.8 / 8 h =
0.8 ops/h/group, ~1.8 ops/s at the peak. Group commit turns that into
<=10 fsync/s (measured 8.5 commits/s under a 93 writes/s burst, fiche 07
§6). Writer capacity is ~1 000 ops/s: 3-4 orders of magnitude of headroom.
Reads x10 = ~18/s = ~9 % of one core (0.5 ms indexed lookup). The real
per-user cost is the polling baseline: 1 sync/20 s + 1 SSE = 2 sockets +
~93 KB RAM (breakdown below).

## Evidence: cgroup tests

Same 12-core / 30 GB box, server confined via cgroup v2 to **1 CPU**
(`cpu.max 100000 100000`) + a RAM cap (`memory.max`, `memory.swap.max=0`);
generator unrestricted. Write profile = real world, not the synthetic
storm: 1 000 ops/year/group (`WRITE_PROB = 1.6e-5`, ~0.2 ops/s at 12k
users vs ~1 700 ops/s in the storm). Each user = 1 HTTP keep-alive + 1 SSE
(2 sockets). Joins staggered at `RAMP_RATE=100` users/s.

| Config | 6k | 10k | 12k | 13k |
|---|---|---|---|---|
| 1 core + 1 GB | OK, p50 0.92 ms, RSS 568 MB, CPU 25 % | **OOM kill at 8 693 users** | - | - |
| 1 core + 2 GB | - | OK, p50 0.92 ms, RSS 857 MB, CPU 42 % | OK, p50 0.94 ms, RSS 1.13 GB, CPU 48 % | OK, p50 0.91 ms, RSS 1.22 GB, CPU 51 % |

All runs: p95 < 3 ms, p99 < 115 ms, 0 protocol errors, SSE wake p50
1-4 ms. (Full latency tables and max-concurrent numbers on bigger boxes:
[fiche 05](05_capacity-and-limits.md).)

**RAM grows ~92.6 KB per concurrent user** (measured 12k -> 13k).
Breakdown at 10k users (cgroup `memory.stat` + `smaps_rollup`):

- ~89 KB process heap: real per-user allocations (hyper/axum connection
  state, tokio tasks, SSE receivers), **not** glibc fragmentation
  (`MALLOC_ARENA_MAX=2` changes only 1.6 KB/user);
- ~8 KB kernel socket memory (2 sockets per user, slab);
- ~2.5 KB page cache (tmpfs DB);
- idle baseline 24 MB = 12 tokio worker-thread stacks (2 MB each) + base.

At 2 GB + 1 core: RAM bounds first (~17k extrapolated), CPU second
(51 % at 13k). Per 1 000 users: 50 sync req/s, ~0.03 real writes/s;
polling + SSE dominate, writes are negligible.

These tests also caught the reader-pool drain bug (server death at 12k on
mass disconnect), fixed with 8 fixed drop-safe slots: [07](07_rust-optimizations.md) §4.

## Budget

| Budget | Concurrent users | Notes |
|---|---|---|
| 1 core + 1 GB, x86 (measured, cgroup) | **~8 000** | OOM kill at 8 693; CPU ~35 % (interpolated 6k->10k) = RAM binds, not the core |
| Pi 3B+ (1 core + 1 GB, extrapolated) | **~5-8k** | ARM A53 = ~0.35-0.5x an x86 core, +/-50 %. A real 3B+ has 4 cores, but at 1 GB the OOM hits first, so the core count does not change the number |
| 1 core + 2 GB (measured / extrapolated) | ~13k clean / ~15-17k | the only upgrade that pays at 1 core: 2 GB = ~2x users (e.g. Pi 4 2 GB) |

## Daily and monthly sizing

Daily users = concurrent / c, where c = share of the fleet connected at
the 14h-22h peak. Only the operator knows c; calibrate on real data
(apps open at a given afternoon hour / total fleet).

| c | 1 core + 1 GB (8k) | Pi 3B+ (5-8k) |
|---|---|---|
| 30 % (very synchronized fleet) | ~27k | 17-27k |
| **10 % (reference: ~40 min presence/day spread over 8 h)** | **~80k** | **50-80k** |
| 5 % (spread out) | ~160k | 100-160k |

Monthly (users active over the month) = daily x 30 / active-days-per-user;
at 10 active days/user that is ~3x daily (fleet estimate, usage-dependent,
not a server limit).

## Deployment checklist (1 core + 1 GB)

No code or concurrency changes needed.

1. `LimitNOFILE=65536` in the service unit. The default (1024 FDs) caps at
   ~500 users, far before RAM. **The only config line that matters.**
2. No tokio worker tuning: M:N scheduler, 1 worker per core by default;
   the measured 1c+1GB run carried ~17k sockets on 1 worker.
3. No `READERS` change: the 8 slots run at ~15 % at 8k users; more slots
   on a single core add mutex contention with no parallelism gain (raise
   it only on multi-core boxes, fiche 05 ceilings).
4. Group commit defaults are fine (<=10 fsync/s at this load); SD card A2
   recommended.
5. Validate on site: `rust/loadtest.py` from a second host,
   `RAMP_RATE=100`, `LEVELS=1000,3000,5000,8000` (~1 h) turns the
   extrapolation into a number.

## Where the other numbers live

- Latency (p50/p99), max concurrent users, degraded network, storage,
  hard limits, architectural ceilings: [05](05_capacity-and-limits.md)
- Every optimization and its measured impact (reader pool, group commit,
  one SSE stream per user): [07](07_rust-optimizations.md)
- A/B Python vs Rust: [06](06_rust-rewrite.md)
