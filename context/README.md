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

## Current state (2026-07-14)

- **Status: Phase 4 (hardening) complete + app-audit fixes (D22) + UX pass for non-technical users (D23).** Full offline PWA + sync + splits/settle/export, PWA install/update prompts, near-instant sync, per-group identity ("Qui etes-vous ?"), undo on expense delete, group rename/delete and participant rename. 85 frontend tests + 20 backend tests pass. Deferred: categories, multi-currency. Next: real use with friends (user-directed). See [04_roadmap.md](04_roadmap.md).
- Dev note: frontend reads `VITE_API_URL` (`.env.development` points at `http://localhost:8065/api/v1`). Backend needs the source-mount + DEBUG reload (already in docker-compose).
- **Auth (D21)**: sync is gated by a shared password (`API_KEY` in backend env; empty = disabled for dev). Client stores it in localStorage once (menu -> "Mot de passe du serveur", or auto-prompted on a 401 from Share/Join). Deploy behind Caddy as one upstream -> the frontend container (which proxies `/api`). See [../DEPLOY.md](../DEPLOY.md).
- Host ports: frontend **3060**, backend **8065**, MariaDB **3307**.
- Backend runs in Docker (Python 3.11); the machine's system Python (3.14) has no wheel for the pinned `pydantic-core`, so do not build a local venv. Run backend tasks (alembic, pytest) inside the container, matching VroomVroom.
- Sibling project **VroomVroom** (`~/Work/VroomVroom`) is the stack reference: same React + FastAPI + Docker/homelab shape.
- Two forking decisions are locked (see 03): **share-code join** and **append-only op-log sync**.

## Rules for updating these docs

1. Any session that changes a decision adds a dated entry to [03_decisions.md](03_decisions.md) (append, chronological). Never rewrite past decisions in place; supersede them with a new entry.
2. Files 01, 02 and 04 describe **current state only**. Update them in place, do not accumulate history there.
3. No em dashes anywhere in these docs (general writing rule).
4. Keep this in sync with `~/Work/VroomVroom` conventions where they overlap.
