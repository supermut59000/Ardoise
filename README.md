# Ardoise

A self-hosted, offline-first Tricount clone. Split shared group expenses, simpler than Tricount, works offline as an installable PWA, and the data stays on your own server.

See [context/](context/) for architecture and decisions. Read [context/README.md](context/README.md) first.

## Stack

- **Frontend**: React 19 + TS + Vite + Tailwind v4 + shadcn/ui + TanStack Query, Dexie (IndexedDB) for local-first storage, vite-plugin-pwa.
- **Backend**: FastAPI + SQLAlchemy 2.0 + Alembic + MariaDB. The backend is a sync relay over an append-only operation log; it never merges state.
- **Infra**: Docker Compose. Frontend on host port 3060, backend on 8065, MariaDB on 3307.

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

## Status

Phase 0 (scaffold) complete and verified: frontend builds with a generated service worker, backend serves `/health` and `/api/v1/system/ping`, MariaDB + Alembic migration applied. See [context/04_roadmap.md](context/04_roadmap.md).
