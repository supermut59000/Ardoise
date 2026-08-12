# Ardoise

A self-hosted, offline-first Tricount clone. Split shared group expenses, simpler than Tricount, works offline as an installable PWA, and the data stays on your own server.

See [context/](context/) for architecture and decisions. Read [context/README.md](context/README.md) first.

## Stack

- **Frontend**: React 19 + TS + Vite + Tailwind v4 + shadcn/ui, Dexie (IndexedDB) for local-first storage with live queries, vite-plugin-pwa (custom service worker for Web Push).
- **Backend**: FastAPI + SQLAlchemy 2.0 + Alembic + MariaDB. The backend is a sync relay over an append-only operation log; it never merges state.
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

## Status

In real use on the homelab. Fully offline PWA with share-code and automatic QR joining, unequal splits, settle-up, CSV/JSON export and import, per-group identity, and Web Push activity notifications. See [context/04_roadmap.md](context/04_roadmap.md) for the phases and [context/03_decisions.md](context/03_decisions.md) for the decision ledger. Deployment lives in [DEPLOY.md](DEPLOY.md).
