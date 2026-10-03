# Ardoise

A self-hosted, offline-first Tricount clone. Split shared group expenses, simpler than Tricount, works offline as an installable PWA, and the data stays on your own server.

See [context/](context/) for architecture and decisions. Read [context/README.md](context/README.md) first.

## Stack

- **Frontend**: React 19 + TS + Vite + Tailwind v4 + shadcn/ui, Dexie (IndexedDB) for local-first storage with live queries, vite-plugin-pwa (custom service worker for Web Push).
- **Backend**: FastAPI + SQLAlchemy 2.0 + Alembic + MariaDB. The backend is a sync relay over an append-only operation log; it never merges state. A Rust port of the same contract (axum + SQLite, one 6.3 MB binary, native Web Push sender) runs in parallel for A/B — see `rust/` and [context/06_rust-rewrite.md](context/06_rust-rewrite.md); the Python stack is the reference.
- **Infra**: Docker Compose. Frontend on host port 3060, backend on 8065 (loopback only), MariaDB unpublished (reachable only over the compose network).

## Quick start (Docker)

```bash
docker compose up -d --build

# Apply DB migrations (first run and after model changes)
docker compose run --rm --no-deps -v ./backend:/app backend alembic upgrade head

# Access
# Frontend: http://localhost:3060
# Backend:  http://localhost:8065  (docs at /docs when DEBUG=true)
```

## Local development

```bash
# Frontend
cd frontend-react
npm install
npm run dev          # http://localhost:3060
npx tsc -b           # typecheck (strict; unused imports are errors)

# Backend runs in Docker (Python 3.11); the repo's Python may be too new
# for pinned wheels. Generate a migration after changing a model:
docker compose run --rm --no-deps -v ./backend:/app backend \
  alembic revision --autogenerate -m "describe change"
```

## Tests

```bash
cd frontend-react && npm test        # vitest

# Backend (pytest is not in the image; install the dev deps first)
docker compose run --rm --no-deps -v ./backend:/app backend \
  sh -c "pip install -q -r requirements-dev.txt && python -m pytest tests/ -q"
```

## Capacity (measured 2026-09-26)

Sizing numbers for the Rust backend (single static binary). The Python
backend caps at ~15 concurrent SSE streams (sync SQLAlchemy on the event
loop) and is not a sizing option. Full data and method:
[context/05_capacity-and-limits.md](context/05_capacity-and-limits.md)
(max users, p50/p99); the 1 core + 1 GB box profile and its deploy
checklist live in
[context/08_small-box.md](context/08_small-box.md).

Per connected user: ~93 KB RAM, 2 sockets (keep-alive + SSE), 1 sync/20 s.
One SSE stream per user no matter how many groups they join (2026-10-03,
context/07 §7) — the per-group streams of before multiplied this cost by
the group count. Writes are negligible (group commit: ≤10 fsync/s even
under a 93 writes/s burst) — capacity is set by **connected users**, not by
ops/day (5–8 ops/day/group sits 3–4 orders of magnitude below the writer
limit).

| Box | Concurrent users | Daily users at c=10 % | Daily users at c=30 % |
|---|---|---|---|
| 1 core + 1 GB (Pi 3B+ class) | ~8k (x86, measured) / 5–8k (Pi, extrapolated) | ~80k / 50–80k | ~27k / 17–27k |
| 1 core + 2 GB | ~15k (13k measured clean) | ~150k | ~50k |
| 12 cores + 30 GB | ~50k comfort / 50–100k wall | 250–500k | 165–330k |

- **Daily = concurrent ÷ c**, where c = share of the fleet connected at the
  afternoon peak (e.g. 14–22 h). **Monthly** ≈ daily × 30 ÷
  active-days-per-user.
- RAM is the binding resource: 2× RAM ≈ 2× users.
- Small-box deploy: one config line matters — `LimitNOFILE=65536` on the
  service (default 1024 FDs caps at ~500 users). No worker or pool tuning
  needed.
- Architectural ceilings and the way past them (reader-pool constant,
  per-group sharding): context/05, "Architectural ceilings".

## Status

In real use on the homelab. Fully offline PWA with share-code and automatic QR joining, unequal splits, settle-up, CSV/JSON export and import, per-group identity, and Web Push activity notifications. See [context/04_roadmap.md](context/04_roadmap.md) for the phases and [context/03_decisions.md](context/03_decisions.md) for the decision ledger. Deployment lives in [DEPLOY.md](DEPLOY.md).
