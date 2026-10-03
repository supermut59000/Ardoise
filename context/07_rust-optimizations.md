# 07 - Rust optimizations and measured impact

Every optimization applied to the Rust backend, in the order they landed,
with the measured impact of each. Two measurement baselines are used
throughout:

- **A/B protocol (fiche 06):** Python stack (uvicorn + SQLAlchemy) vs Rust,
  same N100, same 10k-op seed, median of 7, loopback. The Python side is
  the "before".
- **Constrained-box profile (fiche 05):** 12-core / 30 GB server box for
  ceiling runs, 1 core + 1 GB cgroup for the small-box budget.

## 1. The rewrite itself (2026-09-16)

axum + in-process SQLite (WAL) replacing uvicorn + SQLAlchemy + MariaDB.

| Operation | Python | Rust | gain |
|---|---|---|---|
| ping (server floor) | 1.93 ms | 0.86 ms | 2.2x |
| get group | 4.25 ms | 0.46 ms | 9.2x |
| up-to-date poll (every 20 s) | 4.79 ms | 0.83 ms | 5.8x |
| push, 500-op batch | 69.41 ms | 10.02 ms | 6.9x |
| 10k-op catch-up pull | 565.8 ms | 112.0 ms | 5.1x |
| process RSS (idle) | 102.5 MB | 24.1 MB | 4.3x less |

Footprint: one 6.3 MB static ELF, zero daemons, no Docker. Storage per op:
879 B worst case vs 1.5 KB in MariaDB (1.7x smaller), stable from 10k to
100k ops. The ceiling that disappeared: the Python stack dies at ~15 SSE
streams (synchronous SQLAlchemy inside the event loop, pool 5+10 pinned,
the 16th checkout blocks the loop ~30 s). Rust: 56 263 of 100k users
joined clean under a 100% write storm at 76% of one core.

## 2. One round trip: /sync (2026-09-18)

`POST /groups/{id}/sync` pushes the device ops and pulls since-cursor in
the same request. An idle device costs one request per 20 s instead of
two round trips per local change.

Measured: "peer up to date" end to end 1.2 ms on Rust vs 8.6 ms on Python
(fiche 05 net-contract table); SSE wake p50 ~56 ms, so a wake plus the
triggered sync pass is well under a second on loopback, and the 20 s poll
bounds the worst case anyway.

## 3. SSE wake-up (2026-09-18)

`GET /groups/{id}/events`: `event: op` + `{"seq": N}`, 15 s keepalive.
Wakes carry no data; the pull is the source of truth, so a missed wake is
harmless (the 20 s poll catches up).

Measured: removes the Python 15-stream wall (above); 17k SSE sockets on
one tokio worker carried in the 1c+1GB run (fiche 05); per-socket cost
92.6 KB, breakdown in section 5.

## 4. Reader pool: 8 fixed drop-safe slots (2026-09-26, d50e9f8)

Problem found by the constrained runs: the pop/push reader pool drained on
mass disconnect (task cancellation dropped the connection and no one
re-returned it), `expect()` panicked, server death at 12k users.

Fix: 8 fixed `Arc<Mutex<Connection>>` slots; the guard is released by
`Drop`, so cancellation can never lose a slot. Read path fully
non-blocking: WAL readers never wait on the writer.

Measured: 12k and 13k-user runs clean (13k: 0 errors, p50 0.94 ms,
1214 MB RSS, 55.5% CPU on 1c+2GB). Slots run at ~15% at 8k users.

## 5. RAM profile: 92.6 KB per concurrent user (measured 2026-09-26)

Per-user breakdown at 8k concurrent (1 group each): ~89 KB process heap
(hyper/tokio/SSE real allocations; `MALLOC_ARENA_MAX=2` moved only ~1.6
KB, so it is not a glibc arena issue) + ~8 KB kernel sockets + ~2.5 KB
page cache. Idle process: 24 MB = 12 tokio worker stacks x 2 MB + SQLite.

Impact: RAM binds before CPU on small boxes. 1c+1GB: OOM at 8 693 users
with ~35% CPU (fiche 05 budget table). This number is also the unit of
account for section 7.

## 6. Async writer + group commit (2026-09-26, 932f32d)

Problem: one commit per write = one fsync per write (SD card wear, and
50-100 ms tail latency on cheap storage).

Fix: one batcher task owns the writer connection; ops accumulate and
flush at FLUSH_MS=100 / GRACE_MS=50 / FLUSH_N=100; the HTTP response goes
out only after the commit (no lost ack); `/health` exposes COMMITS.

Measured (A/B at 93 write req/s on btrfs): 8.5 commits/s vs ~93 before
(11x fewer fsyncs); block writes -43%; a solo write costs +50 ms (the
grace window, not real latency); SSE wake p50 ~56 ms. Writer capacity
~1 000 ops/s vs ~1.8 ops/s real peak at 8k users (fiche 05). Two
measurement bugs were caught by the A/B and fixed in the same session: a
solo-flush leak (the batcher kept a last op past its deadline) and
`server_generation()` routing through the writer (now seeded at open,
read on the pool).

## 7. One SSE stream per user: multi-group wake (2026-10-03)

Problem: the cost per user was G x (1 SSE stream + 20 s poll) for G shared
groups. Fiche 05 called this out as the remaining client-side lever.

Fix: `GET /groups/events?groups=a,b,c` serves one SSE stream for all of a
user's groups; frame `event: op` + `{"group":"<id>","seq":N}`. Cap 50
groups per stream (abuse bound, not a product limit); unknown ids are
skipped; 400 on empty list, 404 when nothing is known. The frontend opens
a single stream, reconciled when the set of shared groups changes, and
falls back to per-group streams on 404, so the Python backend keeps
working. **Documented divergence from the "Python is the reference" rule
(fiche 06):** the endpoint is Rust-only, because the Python stack
physically cannot hold the streams this change removes.

Verified: 16/16 Rust unit tests (2 new: header/error paths, wake names
its group); 180/180 frontend tests; full network parity 18/18; live smoke
test (`{"group":"smoke-g2","seq":1}` on a push to smoke-g2, g1 quiet,
400/404 paths clean).

Impact (extrapolated from the 92.6 KB/socket of section 5): per user, G
streams become 1, saving (G-1) x ~93 KB. A fleet where the average user
sits in 2 groups cuts per-user RAM nearly in half: at 1c+1GB that is the
difference between ~4k and ~8k concurrent. No effect on the 1-group
majority (already 1 stream).

## What was deliberately NOT done

- **No tokio worker tuning:** M:N scheduler, 1 worker per core by default;
  17k sockets on one worker measured fine.
- **No `READERS` increase on 1 core:** 8 slots at ~15% at 8k users; more
  slots add mutex contention without parallelism. `READERS = 64` is the
  one-line lever above ~100k on multi-core (fiche 05 ceilings).
- **No broker for the wake fan-out:** in-process broadcast is correct for
  one process; a broker belongs to the scale-out story (shard by group,
  fiche 05 ceiling 3).
- **No per-user RAM reduction yet:** 92.6 KB is dominated by axum/hyper
  connection state. It is the next lever only if RAM still binds after
  section 7 (~8k users per GB).
