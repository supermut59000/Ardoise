# 06 - Rust rewrite: A/B measurements (measured 2026-09-16)

A Rust port of the sync backend (`rust/`, axum + SQLite, one binary) was built
to answer: is Rust actually faster/better for THIS workload? The Python stack
stays in production; the Rust backend runs in parallel for A/B.

Scope: all 13 API endpoints, same contract (verified endpoint-by-endpoint with
curl, including the exact French 401/404/422 messages and the auth matrix:
`/system/ping` public, everything else X-API-Key gated). SQLite WAL replaces
MariaDB (justification: D32 — the DB was never the bottleneck; the log is
reconstructible, so a file DB is acceptable).

The web-push SENDER is ported too (RFC 8291 aes128gcm ECE over reqwest +
p256 + aes-gcm + hkdf + sha2, no new crypto deps beyond that): ephemeral
P-256 ECDH key per message, two-stage HKDF per RFC 8188, no AAD, TTL 3600,
404/410 prune the subscription, VAPID JWT ES256 (exp +43200 s). Without
VAPID set, `push_enabled()` is false and `/push/*` returns 503 — exactly the
Python behavior.

Cross-conformance with the reference stack (`rust/ece_cross_check.py`):
the Rust wire bytes decrypt byte-for-byte with `pywebpush.http_ece.decrypt`,
and the VAPID JWT verifies as ES256 against the public key derived
independently with `cryptography` — **CROSS-CONFORMANCE OK**. One trap
found while proving it: `p256`'s `sign_prehash()` treats the input as an
ALREADY-HASHED digest; ES256 needs `sign()` (SHA-256 applied internally).
`ecdsa` 0.16 also does not normalize to low-S, which strict verifiers
reject — `vapid_jwt` calls `normalize_s()` after signing.

## A/B protocol

Same N100 machine, loopback. Each server got a FRESH SQLite WAL database
seeded with the same 10 000 ops (realistic payloads ~130 B, seed 42).
Median of 7 runs after a warmup run. Pulls were benched before the push
benchmark (pushes append rows and would drift the pull result sets).

- Python: uvicorn single process + SQLAlchemy 2.0 + SQLite (via a new
  `DATABASE_URL` override in config, WAL + synchronous=NORMAL to match).
- Rust: release binary (LTO + strip), single process.

## Latency (median, ms, 10 000-op group)

Current pair, measured 2026-09-18 with the binary that SHIPS (native push
sender included — the 3.6 MB pre-push binary is gone): `rust/bench_ab.py`,
median of 7 after warmup, loopback, both stacks on fresh identical SQLite
seeds.

| Operation | Python (uvicorn+SQLite) | Rust (axum+SQLite) | Rust faster |
|---|---|---|---|
| ping (server floor) | 1.93 | 0.86 | 2.2× |
| get group | 4.25 | 0.46 | 9.2× |
| pull, up-to-date (the every-20s poll) | 4.79 | 0.83 | 5.8× |
| pull, 10 new ops (the common case) | 5.63 | 1.09 | 5.2× |
| pull, full 10 000-op catch-up (4.4 MB JSON) | 565.8 | 112.0 | 5.1× |
| push, 500-op batch | 69.41 | 10.02 | 6.9× |
| **Process RSS** | **102.5 MB** | **24.1 MB** | **4.3× less** |

Caveat: absolute values move run-to-run on the N100 (turbo state, page
cache, load) — the RATIO is stable, the absolutes are not quotable across
days. Python's numbers ran higher than the 2026-09-17 session (76 MB RSS,
19 ms push); that is machine state, not a regression. Cross-check with
fiche 05 (Python + MariaDB): the every-20s poll was 13 ms there — the MariaDB
round-trip is a fixed per-request cost on top, so the Rust-vs-prod-stack gap
is LARGER than this table shows, not smaller.

## Fiche 05 recalc — capacity on the Rust stack

Every measured figure in `context/05_capacity-and-limits.md` re-derived for
Rust + SQLite (script: `rust/capacity_rust.py`, same median-of-7 method).

| fiche 05 item (Python + MariaDB) | Rust + SQLite | ratio |
|---|---|---|
| Op on the wire | 729 B worst-case / 484 B realistic (contract unchanged; fiche 05's 920 B used a bigger worst case) | same |
| Op on disk | **879 B** worst-case / 469 B realistic (WAL checkpointed) vs 1.5 KB MariaDB | **1.7× smaller**, stable 10 k→100 k (87.9 MB at 100 k) |
| Up-to-date pull (20 s poll) | 0.83 ms vs 13 ms | 16× |
| Daily push, 1 op / 3 ops | 0.61 / 0.59 ms vs 20–50 ms | 30–80× |
| Push 500-op batch | 10.0 ms vs 175 ms | 17.5× |
| 10 000-op catch-up push (20 × 500) | 373 ms vs 3.5 s | 9.4× |
| Fresh join, 10 k-op group | 304 ms; 4.4 MB raw → **0.3 MB gzip-5** vs 1.8 s / 8.6 MB | ~6× faster on air, ~15× gzip on JSON |
| Backend RAM | 24 MB, one binary, no daemon vs 76 + 78 MB | 6.4× less |

The table above compares the OLD endpoints (push/pull). The 2026-09-18
network contract (one `/sync` + SSE wake) is measured in the same shape by
`rust/net_bench.py` (its table lives in fiche 05): E2E "peer up-to-date" is
1.2 ms on Rust vs 8.6 ms on Python + SQLite — both single-digit milliseconds,
versus up to 20 s worst case under the old poll.

Client-side fold timings are UNCHANGED (same frontend, same fold.ts):
1 k/5 k/10 k/20 k ops = 1.3 / 7.4 / 13.6 / 34.8 ms on the desktop (re-measured
this session; phone 3-5× slower).

Hard limits: unchanged — they live in the client (`PUSH_BATCH = 500` in
`sync/engine.ts`), the reverse proxy (10 MB body cap) and the client timeout
(15 s), or they are contract-level (string bounds, `NOTIFY_MAX_BATCH`).
Neither backend enforces a server-side per-push op cap; the real guard is
client batch size + the 10 MB proxy cap (a 10 k-op push is ~5 MB, still
under it). Property of the stack, documented here so it isn't rediscovered.

## Footprint

| What | Python stack (prod) | Rust |
|---|---|---|
| Backend process RSS | 76 MB (uvicorn+SQLAlchemy) + MariaDB 78 MB | 24 MB |
| Database daemon | MariaDB | none (WAL file) |
| Process count | MariaDB + backend + (nginx) | 1 |
| Deploy artifact | Docker image + DB container | 6.3 MB static ELF (3.6 MB before the push sender; reqwest+rustls+p256) |

The brag: **24 MB, one 6.3 MB binary, zero daemons, no Docker, no npm.**
A phone could run it.

## The honest verdict

- Rust is 2.2-9.2× faster per request here. The speed is real but so is the
  ceiling: the app was already instant (fiche 05). Nobody feels 4.8 ms vs
  0.8 ms on a poll; the 10k catch-up going from 566 ms to 112 ms is nice, not
  transformative.
- The win that matters is the footprint: no DB daemon, ~4× less RAM (24 vs
  102 MB same-state; 24 vs 154 MB vs prod Python+MariaDB), one file to
  deploy, one less attack surface (SQLAlchemy/PyMySQL dependency tree gone),
  and 1.7× smaller storage per op (879 B vs 1.5 KB).
- The cost that matters: ~1 100 lines of Rust to replace 979 of Python and a
  second codebase to audit (security-audit.md and the red-team report now
  cover only the Python one). The compiler catches type errors, not sync
  invariants — so the Rust crate carries 14 unit tests: wire validation
  bounds (incl. the `/sync` wire shape), the exact French push messages, amount
  formatting, the aes128gcm round-trip with an independent client key, VAPID
  JWT ES256 verification, register idempotency + case-insensitive resolve, push
  idempotency + cursor, pull ordering + ahead-cursor auto-heal, `/sync`
  push+pull semantics against a temp DB, SSE keep-alive/wake fan-out and the
  CORS config (`cargo test --release`).
- Maintenance rule while both exist: the Python backend is the reference
  implementation. Any contract change lands in Python first, gets mirrored in
  Rust, and is verified with `rust/parity_check.py` (the automated A/B matrix
  below).

## Network contract, 2026-09-18: one round trip + SSE wake-up

Before: every device change cost TWO requests (push, then poll). After:

- `POST /groups/{id}/sync` — push `ops` (idempotent, same dedup rules, same
  500-batch client cap) and pull everything `seq > since` in the SAME request,
  so a device learns the seq of its own ops without a second round trip. One
  idle sync = one request. `since < 0` → 422 on both backends (Pydantic `ge=0`
  vs the Rust guard); unknown group → 404 before any mutation.
- `GET /groups/{id}/events` — SSE wake-up stream. On new accepted ops (and
  only then: dedups and reseeded pushes don't wake) the server sends one
  minimal frame, `event: op` + `data: {"seq": N}` — a wake-up, never the data.
  The client re-syncs to get the ops. 15 s keep-alive comment, `: connected`
  first comment, `X-Accel-Buffering: no`, `Cache-Control: no-cache`.
  Python: in-process `asyncio.Queue` fan-out per group (single-process deploy
  only, like the push fan-out). Rust: `tokio::sync::broadcast` per group
  (capacity 64; a lagged subscriber gets a `: lagged` comment and the next
  re-sync catches up — the stream never carries truth).
- Client (`frontend-react`): the engine does per-batch `/sync` (500 ops each,
  mark-synced as it lands, self-heal generation/cursor logic unchanged); the
  hook keeps ONE SSE stream per user for all shared groups: Rust endpoint
  `GET /groups/events?groups=a,b,c` (wake frame carries the group id, cap
  50), reconciled when the group set changes (reconnect backoff 1 s → 30 s,
  `fetch` + `ReadableStream` because `EventSource` cannot send `X-API-Key`);
  on 404 it falls back to one stream per shared group (Python backend,
  which has no multi endpoint: documented divergence, fiche 07 §7); the 20 s
  poll stays as the fallback for SSE-unfriendly proxies.

A/B parity matrix (`rust/parity_check.py`, both backends live, 18/18 green on
2026-09-18): register; `/sync` accepted/cursor/ops body/serverGeneration;
dedup (`accepted=0`, cursor, ops); error paths (`/sync` 404 unknown group,
422 `since<0`, `/events` 404); SSE headers (content-type with charset,
cache-control, x-accel-buffering); first comment; wake frame shape + `seq`
payload on a concurrent push. The only cosmetic diff: Python's JSON pretty-
spaces (FastAPI) vs compact (serde) — semantically identical.

## Running it

```bash
# 1. build the frontend (dist/ is not in git)
cd frontend-react && npm ci && npm run build && cd ..
# 2. build the binary
cd rust && cargo build --release && cd ..
# 3. run (from the repo root so the default STATIC_DIR resolves)
API_KEY="<same as python>" PORT=8001 DATA_FILE=/var/lib/ardoise/ardoise.db \
  rust/target/release/ardoise
```

The binary serves everything: /api/v1, /health, and the built frontend
(`frontend-react/dist/`, override with `STATIC_DIR`). Any non-file path
returns index.html with a 200 (SPA fallback, like nginx `try_files`).
`dist/` missing = statics 404, /api still works. Optional env: `CORS_ORIGINS`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. The docker-compose stack (mariadb,
backend, frontend) is fully retired by this: the SQLite file replaces
MariaDB, and the binary replaces nginx for statics. A systemd unit
(Restart=always) replaces compose's `restart: unless-stopped`.

Frontend dev mode: `frontend-react/.env.development` points at
`localhost:8001` (Python alternative is in the comment).

Caddy at the cutover (the live Caddyfile lives in the Caddy LXC, not in
this repo). Everything goes to the Rust binary over h2c so each user holds
one backend connection (SSE + sync + statics multiplexed) instead of two.
Needs Caddy >= 2.7 for the `protocol` directive. The Rust binary accepts
h2c (axum `http2` feature enabled, verified with
curl --http2-prior-knowledge), so the cutover is this Caddyfile block only.
Apply only at the cutover: the Python stack is h1-only, pointing h2c at it
would break it. After deploying, check the backend sees ~1 established
connection per connected user (`ss -tn` on port 8001), not 2.

```caddy
ardoise.ouiouibaguette.fr {
    import security_headers
    request_body {
        max_size 12MB
    }
    reverse_proxy 192.168.25.25:8001 {
        protocol h2c
        flush_interval -1
    }
}
```

Reproduce the bench: `rust/bench_ab.py` (seeds both DBs, restarts each
server, writes `/tmp/ab-results.json`; ~3 min).

Reproduce the push cross-conformance: `cd rust && cargo build --release &&
../backend/.venv/bin/python ece_cross_check.py`. Note: `cargo test` alone
does NOT refresh `target/release/ardoise` — the cross-check spawns the
release binary, so build it explicitly first.

Reproduce the A/B network parity: `cd rust && cargo build --release &&
../backend/.venv/bin/python -u parity_check.py` (starts one live server per
backend on free ports, exits 0 on full parity, ~20 s).

Reproduce the network-contract bench: `cd rust && cargo build --release &&
../backend/.venv/bin/python -u net_bench.py` (seeds 10k ops per backend,
median of 7, writes `/tmp/net-bench.json`, ~2 min). Note: its
"full-group join" row pulls the group AFTER the catch-up runs, so the
bench group holds ~53.5 k ops (9.4 MB), not 10 k — fiche 05 labels it as
such. A true 10 k join is 1.74 MB raw / 150 KB gzip-5 (see the degraded-
network table there).

Reproduce the degraded-network bench: `cd rust && cargo build --release &&
rm -f /tmp/netb-* && ../backend/.venv/bin/python -u net_impact.py`
(3 profiles behind `rust/netem.py` rootless TCP proxies: wifi, 4g, flaky;
median of 7, writes `/tmp/net-impact.json`, ~7 min).
