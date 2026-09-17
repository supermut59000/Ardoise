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

| Operation | Python | Rust | Rust faster |
|---|---|---|---|
| ping (server floor) | 0.96 | 0.47 | 2.0× |
| get group | 2.22 | 0.32 | 6.9× |
| pull, up-to-date (the every-20s poll) | 2.17 | 0.38 | 5.7× |
| pull, 10 new ops (the common case) | 2.23 | 0.52 | 4.3× |
| pull, full 10 000-op catch-up (3 MB JSON) | 268 | 57 | 4.7× |
| push, 500-op batch | 33.6 | 5.7 | 5.9× |

Cross-check with fiche 05 (Python + MariaDB, worst-case ~920 B ops): the
every-20s poll was 13 ms there vs 2.2 ms here — the MariaDB round-trip is a
fixed per-request cost on top of what was benched. The Rust-vs-real-stack gap
is therefore LARGER than the table shows, not smaller.

## Footprint

| What | Python stack (prod) | Rust |
|---|---|---|
| Backend process RSS | 76 MB (uvicorn+SQLAlchemy, SQLite-only bench) | 23 MB |
| Database daemon | MariaDB, 78 MB tuned (fiche 05) | none (WAL file) |
| Process count | MariaDB + backend + (nginx) | 1 |
| Deploy artifact | Docker image + DB container | 3.6 MB static ELF |

The brag: **23 MB, one 3.6 MB binary, zero daemons, no Docker, no npm.**
A phone could run it.

## The honest verdict

- Rust is 4-7× faster per request here. The speed is real but so is the
  ceiling: the app was already instant (fiche 05). Nobody feels 2 ms vs
  0.4 ms on a poll; the 10k catch-up going from 268 ms to 57 ms is nice, not
  transformative.
- The win that matters is the footprint: no DB daemon, ~3× less RAM, one
  file to deploy, one less attack surface (SQLAlchemy/PyMySQL dependency tree
  gone).
- The cost that matters: ~1 100 lines of Rust to replace 979 of Python and a
  second codebase to audit (security-audit.md and the red-team report now
  cover only the Python one). The compiler catches type errors, not sync
  invariants — so the Rust crate carries 9 unit tests: wire validation
  bounds, the exact French push messages, amount formatting, the aes128gcm
  round-trip with an independent client key, VAPID JWT ES256 verification,
  register idempotency + case-insensitive resolve, push idempotency + cursor,
  and pull ordering + ahead-cursor auto-heal (`cargo test --release`).
- Maintenance rule while both exist: the Python backend is the reference
  implementation. Any contract change lands in Python first, gets mirrored in
  Rust, and is verified against this fiche's curl matrix.

## Running it

```bash
cd rust && cargo build --release
API_KEY="<same as python>" PORT=8001 DATA_FILE=/var/lib/ardoise-rust.db \
  ./target/release/ardoise
```

Frontend: `frontend-react/.env.development` points at `localhost:8001`
(Python alternative is in the comment). Production nginx would need a second
upstream or a port flip — not wired yet, by design.

Reproduce the bench: `rust/bench_ab.py` (seeds both DBs, restarts each
server, writes `/tmp/ab-results.json`; ~3 min).

Reproduce the push cross-conformance: `cd rust && cargo build --release &&
../backend/.venv/bin/python ece_cross_check.py`. Note: `cargo test` alone
does NOT refresh `target/release/ardoise` — the cross-check spawns the
release binary, so build it explicitly first.
