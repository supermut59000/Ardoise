# 07 - Rust optimizations and measured impact

Every optimization applied to the Rust backend, in the order they landed,
with the measured impact of each. Two measurement baselines are used
throughout:

- **A/B protocol (fiche 06):** Python stack (uvicorn + SQLAlchemy) vs Rust,
  same N100, same 10k-op seed, median of 7, loopback. The Python side is
  the "before".
- **Constrained-box profile (fiche 08):** 1 core + 1 GB cgroup for the
  small-box budget; 12-core / 30 GB box for ceiling runs (fiche 05).

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
one tokio worker carried in the 1c+1GB run (fiche 08); per-socket cost
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
with ~35% CPU (fiche 08 budget table). This number is also the unit of
account for section 7.

## 6. Async writer + group commit (2026-09-26, 932f32d)

Problem: every write was its own transaction + commit + fsync. In a burst
(870 write requests/s at 12k storm users) that is ~870 fsync/s of disk
wear; the real profile is ~0.2 writes/s. Goal: cap the commit rate at
10/s under bursts, unchanged at idle.

How: a dedicated batcher task owns the writer `Connection` (never shared,
no lock). All write paths (`server_generation`, `register_group`,
`push_ops`, `sync_ops`, `upsert_sub`, `delete_sub`) queue a closure via
an `mpsc` channel and await a oneshot reply. The batcher drains what is
already queued (cap `FLUSH_N = 100` writes per batch); a write arriving
to an empty queue waits `GRACE_MS = 50` for a following write before
committing alone; a concurrent burst waits out the 100 ms window
(`FLUSH_MS`) so it lands in one commit; the batch applies in one
transaction, one commit. A failed statement aborts the batch: ROLLBACK,
every job in it gets an error (all writes are idempotent, clients retry).

Crash safety (kept): the reply lands **after** the commit. A crash inside
the window ACKs nothing; the client re-pushes and the `op_id` unique
index makes the replay a no-op.

Latency cost: a solo write is ACKed up to 50 ms (grace) after arrival;
a burst up to 150 ms (grace + window). Invisible against the 20 s sync
cadence. SSE publish happens after the write returns, so events still
follow the commit.

Measured (6k-user write storm, 31% of syncs carry writes = ~93 write
requests/s sustained, DB on btrfs, 1 core + 2 GB, staggered joins):

| | per-write commit (before) | group commit (after) |
|---|---|---|
| commits = fsyncs/s | ~93 (1 per write) | **8.5** (100 ms window cap) |
| block writes | 2.4-3.1 MiB/5 s | 1.3-1.9 MiB/5 s (-43%) |
| 6k joined / errors | 6 000 / 0 | 6 000 / 0 |
| sync p50 | 2.2 ms | 2.3 ms (read-only syncs unchanged) |
| sync p95 | 23.6 ms | 112.6 ms (write-carrying syncs pay the window) |
| CPU | 74.6% | 66.8% |

11x fewer fsyncs, the wear-relevant metric (the byte reduction is
smaller because op data dominates page-cache writeback). Commit count
exposed in `/health` (`commits`) since this change. No regression in the
real profile: 12k / 13k clean. Writer capacity ~1 000 ops/s vs ~1.8
ops/s real peak at 8k users (fiche 08).

Two bugs the first measurements caught, both fixed before the numbers
above:

1. **No-grace leak:** without the grace, a steady 93 writes/s streamed
   through as one commit per write (each arrival finds an empty queue):
   measured 97.6 commits/s, zero batching.
2. **Reads misrouted to the writer:** `server_generation()` (called by
   every `/sync`) went through the writer, so the grace added 50 ms to
   every read-only sync (12k p50 went 1.2 ms -> 57 ms). Fixed by seeding
   `server_meta.generation` once at open and reading it on the reader
   pool; after the fix, read-only syncs stay at p50 ~2 ms.

Harness finding (not a server limit): `RAMP_RATE=0` = 12k users
connecting + SSE + first sync all at t=0; a 1-core server cannot finish
those joins inside the 15 s harness timeout (~2k join, ~10k time out,
identically on the pre-batching binary, server CPU ~18%). Staggered
joins (`RAMP_RATE=100`) pass 12k-13k clean on both binaries. If a real
deployment ever joins thousands of clients in one instant, the fix is
client-side join jitter, not server capacity.

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

## 8. SSE forwarder micro: one task per connection (2026-10-03)

Two micro-reductions to per-connection state. Semantics are unchanged: a
wake is a hint, the 20 s poll is the truth.

- **G forwarder tasks became 1.** The multi-group stream spawned one task
  per group, each forwarding its broadcast receiver into the mpsc. Now a
  single task multiplexes the G receivers (`select_all` over per-group
  `unfold` streams) and feeds one mpsc. Saves (G-1) tokio tasks and (G-1)
  cloned senders per connection: ~0.5 to 1 KB at G=2..5, zero for the
  1-group majority.
- **mpsc capacity 256 to 1.** A wake carries no data, so at most one
  pending wake matters; the rest coalesce.

Implementation notes (pitfalls actually hit): tokio's `broadcast::Receiver`
neither implements `Stream` nor is `Unpin`, and a `recv()` future dropped
between polls loses its waker registration, so publishes stop waking it.
Each group is therefore an `unfold` that passes `(receiver, group name)`
as state by value: the per-item future stays alive across polls and owns
everything it uses. The streams are boxed as `Pin<Box<dyn Stream>>`
because `select_all` requires `Unpin`.

Verified: 16/16 Rust unit tests (including the multi-group wake-names-its-
group test); live smoke (push to g2 yields `{"group":"g2","seq":1}`,
g1 silent).

RAM note: the dominant 92.6 KB per user (hyper/axum connection state,
section 5) is untouched; this trims the per-connection extras.

## What was deliberately NOT done

- **No jemalloc:** swapping the process allocator is not a pure micro; it
  wants a full regression pass (unit tests plus the cgroup ceiling run)
  before it earns its 5 to 15%. Revisit if RSS still binds.

- **No tokio worker tuning:** M:N scheduler, 1 worker per core by default;
  17k sockets on one worker measured fine.
- **No `READERS` increase on 1 core:** 8 slots at ~15% at 8k users; more
  slots add mutex contention without parallelism. `READERS = 64` is the
  one-line lever above ~100k on multi-core (fiche 05 ceilings).
- **No broker for the wake fan-out:** in-process broadcast is correct for
  one process; a broker belongs to the scale-out story (shard by group,
  fiche 05 ceiling 3).
- **No per-user RAM reduction of the connection state itself:** the 92.6 KB
  is dominated by axum/hyper state per TCP connection. Section 8 trimmed the
  per-connection extras; the real lever is one connection per user instead
  of two (HTTP/2 from the proxy, see the Caddy note in fiche 06), only if
  RAM still binds after that (~8k users per GB).
