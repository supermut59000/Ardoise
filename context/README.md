# Context - Ardoise (self-hosted Tricount clone)

> **Read this at the start of every work session on this repo.**
> Read files 01, 02 and 03 before any analysis or change. File 04 (roadmap) on demand.

Working name: **Ardoise** (FR "slate / bar tab"). Rename freely.
Goal: split shared group expenses, simpler than Tricount, **you own the data** (self-hosted on the homelab), installable **PWA** that works **offline** on iOS and Android.

## Context files

| File | Content | Read |
|---|---|---|
| [01_architecture.md](01_architecture.md) | Tech stack, domain model, project structure | **Always** |
| [02_sync-and-offline.md](02_sync-and-offline.md) | The operation-log sync engine, offline/PWA constraints | **Always** |
| [03_decisions.md](03_decisions.md) | Decision ledger (what was decided, when, and why) | **Always** |
| [04_roadmap.md](04_roadmap.md) | Phased roadmap and current build status | On demand |
| [05_capacity-and-limits.md](05_capacity-and-limits.md) | Measured storage/timing/RAM numbers and hard limits | On demand |

## Current state (2026-07-14)

- **Status: Phase 4 complete + audit/UX passes D22-D31, deployed for real use.** Full offline PWA + sync + splits/settle/export/import, install/update prompts, near-instant sync, per-group identity ("Qui etes-vous ?", "Ma part", personal balance headline), undo on expense delete, group rename/delete/leave, participant rename, expense emojis, visual pass, safe-area FAB, always-French DateField. **Sync self-heals after server data loss (D29). Web Push notifications for group activity (D30, verified on a real Android device): custom SW via injectManifest, Android/desktop everywhere, iOS 16.4+ installed-only, author never notified of own edits; title = group name and deletes name the deleted item (D31); needs VAPID key + migration at deploy.** 119 frontend + 35 backend tests pass. Deferred: categories, multi-currency. Next: feedback from real use with friends (user-directed). See [04_roadmap.md](04_roadmap.md).
- Dev note: frontend reads `VITE_API_URL` (`.env.development` points at `http://localhost:8065/api/v1`). Backend needs the source-mount + DEBUG reload (already in docker-compose).
- **Auth (D21)**: sync is gated by a shared password (`API_KEY` in backend env; empty = disabled for dev). Client stores it in localStorage once (menu -> "Mot de passe du serveur", or auto-prompted on a 401 from Share/Join). Deploy behind Caddy as one upstream -> the frontend container (which proxies `/api`). See [../DEPLOY.md](../DEPLOY.md).
- Host ports: frontend **3060**, backend **8065**, MariaDB **3307**.
- Backend runs in Docker (Python 3.11); the machine's system Python (3.14) has no wheel for the pinned `pydantic-core`, so do not build a local venv. Run backend tasks (alembic, pytest) inside the container, matching VroomVroom. pytest is NOT in the image; install test deps first: `docker compose run --rm --no-deps -v ./backend:/app backend sh -c "pip install -q -r requirements-dev.txt && python -m pytest tests/ -q"`.
- Sibling project **VroomVroom** (`~/Work/VroomVroom`) is the stack reference: same React + FastAPI + Docker/homelab shape.
- Two forking decisions are locked (see 03): **share-code join** and **append-only op-log sync**.

## Rules for updating these docs

1. Any session that changes a decision adds a dated entry to [03_decisions.md](03_decisions.md) (append, chronological). Never rewrite past decisions in place; supersede them with a new entry.
2. Files 01, 02 and 04 describe **current state only**. Update them in place, do not accumulate history there.
3. No em dashes anywhere in these docs (general writing rule).
4. Keep this in sync with `~/Work/VroomVroom` conventions where they overlap.
