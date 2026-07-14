# 03 - Decision ledger

Append-only. Newest decisions at the bottom. Never rewrite a past entry; supersede it with a new dated one.

Format per entry: **ID - date - decision**. Then *Rationale*, *Alternatives considered*, and *Status*.

---

### D1 - 2026-07-13 - Build a self-hosted, offline-first Tricount clone as a PWA

Working name **Ardoise**. Split shared group expenses, simpler than Tricount, installable on iOS and Android, works offline, self-hosted so the user owns the data.
- *Rationale*: wants a simpler Tricount where the data is his, on his own homelab.
- *Status*: active.

### D2 - 2026-07-13 - Reuse the VroomVroom stack

React 19 + TS + Vite + Tailwind v4 + shadcn/ui + TanStack Query on the frontend; FastAPI + SQLAlchemy 2.0 + Pydantic 2 + Alembic + MariaDB on the backend; Docker Compose on the homelab behind the reverse proxy (`*.home.ouiouibaguette.fr`).
- *Rationale*: same muscle memory as the sibling VroomVroom project; only learn the genuinely new pieces (Dexie, sync).
- *Status*: active.

### D3 - 2026-07-13 - Dexie (IndexedDB) is the local source of truth

The device store, not the server, is authoritative. UI reads/writes hit Dexie first.
- *Rationale*: offline-first; the UI must never wait on the network.
- *Alternatives*: localStorage queue only (VroomVroom style). Rejected: not enough for multi-writer shared state.
- *Status*: active.

### D4 - 2026-07-13 - PWA via vite-plugin-pwa (Workbox)

Instead of the hand-rolled `sw.js` used in VroomVroom.
- *Rationale*: precache, update flow, and Background Sync (where supported) for free; less bespoke SW code to maintain.
- *Status*: active.

### D5 - 2026-07-13 - Sync model: append-only operation log (local-first)

Every change is an immutable op; state = deterministic replay of ops; last-writer-wins per field by `(lamport, op_id)`; delete beats concurrent edit. Server only stores and serves ops, never merges. Full detail in [02_sync-and-offline.md](02_sync-and-offline.md).
- *Rationale*: a Tricount is multi-writer; this gives conflict-free merge plus a free audit history. Chosen by the user over the simpler option.
- *Alternatives*: entity last-write-wins (sync whole entities with `updated_at` + soft delete). Rejected: concurrent edits can silently lose a field and there is no history.
- *Status*: active (user-confirmed 2026-07-13).

### D6 - 2026-07-13 - Sharing model: share-code / link join

Creating a group mints a `share_code`; anyone with the code/link joins and can add expenses. Optional per-group PIN. No email, no password.
- *Rationale*: lowest friction, matches Tricount, still private and self-hosted. Chosen by the user.
- *Alternatives*: full email/password accounts (rejected: overkill, more to build); single-user only (rejected: loses the whole point of splitting with others).
- *Status*: active (user-confirmed 2026-07-13).

### D7 - 2026-07-13 - Money as integer cents, deterministic remainder

All amounts stored as integer cents, never floats. Uneven splits distribute the leftover cent by cent deterministically (first N members get +1 cent).
- *Rationale*: avoid floating-point money bugs; splits must always net to zero.
- *Status*: active.

### D8 - 2026-07-13 - Phase 1 ships fully offline with no backend

The first usable milestone is a single-device, installable, fully-offline PWA backed only by Dexie. Backend and sync arrive in Phase 2.
- *Rationale*: fastest path to something real and testable; de-risks the offline core before adding sync.
- *Status*: active. See [04_roadmap.md](04_roadmap.md).

### D9 - 2026-07-13 - Data ownership: self-hosted + first-class export

Backend runs on the homelab. CSV and JSON export are core features, not afterthoughts.
- *Rationale*: "you own the data" is a hard requirement, not a slogan.
- *Status*: active.

### D10 - 2026-07-13 - Host ports 3060 / 8065 / 3307

Frontend 3060, backend 8065, MariaDB 3307.
- *Rationale*: VroomVroom-style numbering, but MariaDB on 3307 so it does not clash with VroomVroom's 3306 if both run.
- *Status*: active.

### D11 - 2026-07-13 - Backend runs in Docker only (no local venv)

Backend tasks (uvicorn, alembic, pytest) run inside the Python 3.11 container.
- *Rationale*: the machine's system Python is 3.14 and the pinned `pydantic-core` wheel does not build there. Matches VroomVroom's "run backend in Docker" convention.
- *Status*: active.

### D12 - 2026-07-13 - Server operation table shape

`operations` has a server-assigned `seq` (BigInteger autoincrement PK) as the pull cursor, a unique client `op_id` for idempotent push, `payload` as portable SQLAlchemy `JSON` (lands as LONGTEXT on MariaDB), and a composite index `(group_id, seq)` for the pull path. A minimal `groups` table holds only `id` + unique `share_code` for join discovery; no expense data lives server-side.
- *Rationale*: implements the op-log sync of D5 with an efficient, idempotent push/pull; keeps the server a dumb relay.
- *Status*: active. Endpoints (push/pull, group create/join) come in Phase 2; the schema exists now.

### D13 - 2026-07-13 - Frontend Docker builder uses node:22-slim + npm install

The frontend build stage uses `node:22-slim` (glibc) and `npm install --no-audit --no-fund`, not `node:22-alpine` + `npm ci`.
- *Rationale*: native build tools (oxc/lightningcss) ship platform-specific optional deps (`@emnapi/*`, `*-linux-*`). A lockfile generated on the glibc host with npm 11 omits the wasm-fallback branch that the container's npm 10 recomputes as needed, so strict `npm ci` aborts with "Missing @emnapi/core from lock file". `npm install` reconciles per-platform against the lock. glibc base avoids the musl wasm fallback entirely.
- *Alternatives*: `npm ci` on alpine (rejected: the failure above); pinning/patching the lockfile for all platforms (rejected: fragile, not worth it for a self-hosted app).
- *Status*: active. Full stack verified: `docker compose up` serves frontend (3060), backend health (8065), manifest + service worker.

### D14 - 2026-07-13 - State = fold of the whole op log, no denormalized entity tables (Phase 1)

The client keeps only the `operations` log (+ `meta`) in IndexedDB. Current groups/members/expenses are a pure `foldOps(ops)` recomputed on read via useLiveQuery, not stored as separate Dexie tables.
- *Rationale*: one source of truth, zero denormalization-sync bugs; fold is a single heavily-tested pure function. Expense counts per group are small, so recompute-on-read is fine.
- *Alternatives*: maintain derived `groups`/`members`/`expenses` tables updated per op (rejected for Phase 1: more code, more bugs; revisit only if a group ever gets large enough to matter, a Phase 3 perf concern).
- *Status*: active.

### D15 - 2026-07-13 - Fold merge rules: LWW per field, delete terminal, ordering by (lamport, opId)

foldOps sorts ops by (lamport, opId), dedupes by opId (idempotent replay), merges update fields last-writer-wins, treats delete as terminal (a delete always beats a concurrent or later edit), and drops orphan update/delete whose create is absent.
- *Rationale*: gives deterministic convergence across devices regardless of arrival order (proven by a 200-permutation test), matches user intent that a removed item stays removed, and is robust to malformed/partial op streams from sync.
- *Alternatives*: per-field vector clocks / full CRDT (rejected: overkill for this domain); allowing edits to resurrect deletes (rejected: surprising).
- *Status*: active. Note the ingest rule (D5/ingestOps): a device receiving remote ops must advance its lamport past them, or a fresh local op can collide and sort out of order. A test caught exactly this.

### D16 - 2026-07-13 - UI conventions: burger menu, dark mode, swipe actions

Before Phase 2, added a UI pass:
- **Dark mode** via `next-themes` (`attribute="class"`, storageKey `ardoise-theme`, default system). The `.dark` CSS variant already existed. Toaster follows the theme ([components/ui/sonner.tsx](../frontend-react/src/components/ui/sonner.tsx)). Toggle lives in the burger menu on both the Groups home and GroupDetail.
- **Burger menu** (radix DropdownMenu, [components/ui/dropdown-menu.tsx](../frontend-react/src/components/ui/dropdown-menu.tsx)) on GroupDetail holds: Participants (opens a manage dialog with add/remove, [components/group/ParticipantsDialog.tsx](../frontend-react/src/components/group/ParticipantsDialog.tsx)), theme toggle, and disabled placeholders for later features (rename group, share [Phase 2], export). Adding a participant moved out of the page body into this menu/dialog.
- **Swipe to edit/delete** expenses via `SwipeableCard` ported from VroomVroom ([components/ui/swipeable-card.tsx](../frontend-react/src/components/ui/swipeable-card.tsx)): swipe right = edit, swipe left = delete; tapping a row also opens edit (desktop path). The expense form was generalized to add+edit ([pages/ExpenseForm.tsx](../frontend-react/src/pages/ExpenseForm.tsx), routes `/g/:groupId/add` and `/g/:groupId/e/:expenseId`), with a delete button in edit mode.
- New shadcn-style primitives: dropdown-menu, dialog (radix `radix-ui` unified package, same as the Button's Slot).
- *Rationale*: user request; keeps the main screen clean and reuses VroomVroom interaction patterns.
- *Status*: active. Verified: tsc clean, 53 tests still pass, build emits SW, all modules transform, radix namespaces resolve. Not click-tested in a browser (no driver here).

### D17 - 2026-07-13 - Native controls in dark mode via color-scheme

Added `color-scheme: light` on `:root` and `color-scheme: dark` on `.dark` in index.css.
- *Rationale*: the native `<select>` option popup and `<input type=date>` picker are OS-rendered and defaulted to white-on-white in dark mode. `color-scheme` is the correct fix (styling the closed control is not enough).
- *Status*: active.

### D18 - 2026-07-13 - Sync protocol and client/server split (Phase 2)

Server is a dumb append-only relay: `register` (idempotent, mints share code), `resolve`, `push` (dedup by opId, assigns `seq`), `pull` (seq > cursor). It never merges. Wire format = the client Operation minus the local `synced` flag; `created_at` is client ms epoch stored as BigInteger. Client tracks a per-group `syncState {cursor, shareCode}` (Dexie v2); the sync engine pushes unsynced ops then pulls since cursor and folds via ingestOps. Sync is opportunistic (mount/online/visibility/30s), never blocks the UI, and swallows per-group errors for retry.
- *Rationale*: all merge intelligence already lives in the deterministic client fold (D15), so the server stays trivial, horizontally trivial to reason about, and offline-first holds: a device works fully offline and catches up on reconnect. Only shared/joined groups sync; local-only groups never touch the network.
- *Alternatives*: server-side merge / conflict resolution (rejected: duplicates the fold, adds a second source of truth); websockets/live push (deferred: interval + foreground is enough and iOS-friendly).
- *Status*: active. Verified: 13 backend pytest, 6 engine tests (two-device convergence, offline queue, idempotent resync), live curl round-trip, CORS for the dev origin. A share code registers the group; joining pulls its whole log. Group is required to be registered before push (404 otherwise).

### D19 - 2026-07-13 - nginx reverse-proxies /api to the backend (single origin)

The frontend container's nginx now proxies `location /api/ -> http://backend:8000`. The built frontend calls same-origin `/api/v1` (no `VITE_API_URL` baked into the image), so the whole dockerized app is one origin at the frontend port.
- *Rationale*: the production build had no API base and nginx returned the SPA index.html for `/api/*`, so every sync/share call failed with "Connexion au serveur requise" even though the backend was healthy. Same-origin proxy is the correct fix and the intended production topology (own-your-data, one host). `VITE_API_URL` is now only for `npm run dev` (which points at the backend on :8065 with CORS).
- *Gotcha*: `vite dev` and the docker frontend both use host port 3060; run only one at a time, or change the dev port.
- *Status*: active. Verified: `curl localhost:3060/api/v1/system/ping` -> ok; register/resolve round-trip through the frontend origin.

### D20 - 2026-07-14 - Phase 3 scope: unequal splits, settle-up, export (categories + multi-currency deferred)

User chose to build unequal splits, settle-up recording, and CSV/JSON export this pass; removed receipt photos from the roadmap entirely; deferred categories and multi-currency (one currency per group stays).
- **Split modes**: `SplitMode` on Expense, absent = equal (Phase 1/2 expenses unaffected). `computeOwed` handles equal/shares/percent as proportional weights (reusing `splitCents`, so the total is always conserved) and exact as verbatim cents. `validateSplit` guards exact-sums-to-total and percent-sums-to-100 in the UI.
- **Settlements**: modelled as a first-class op entity (`entity: 'settlement'`), folded with the same LWW/delete-terminal rules, so they sync through the existing relay with zero backend change. `computeBalances` applies them (from +amount, to -amount) and still nets to zero.
- **Export**: pure builders (`buildJsonExport` = full op log; `buildCsvExport` = French `;`/comma CSV with per-participant repartition + UTF-8 BOM) separated from thin DOM download wrappers so they are unit-tested.
- *Rationale*: the op-log + fold architecture made splits/settlements additive (no schema/relay changes); export of the raw op log is the truest "own your data".
- *Status*: active. Verified: 78 FE tests (split-modes, settlements, export, exact-split+settle scenario), tsc clean, build, dev-server transform. Not click-tested in a browser.

### D21 - 2026-07-14 - App-level shared password (X-API-Key), stored once in the browser

For internet exposure behind Caddy, sync is gated by a single shared instance password, not Caddy basic-auth.
- **Backend**: `API_KEY` setting (empty = disabled for dev). `require_api_key` dependency (constant-time compare via `secrets.compare_digest`) on the groups + ops routers; `GET /system/auth-check` validates a candidate key. `/health` and `/system/ping` stay open. Header name `X-API-Key` (already in CORS allow-list).
- **Frontend**: [lib/auth.ts](../frontend-react/src/lib/auth.ts) stores the key in localStorage permanently; [client.ts](../frontend-react/src/sync/client.ts) attaches `X-API-Key` on every request and throws a 401 SyncError on rejection; [ApiKeyDialog](../frontend-react/src/components/layout/ApiKeyDialog.tsx) validates via `checkApiKey` then stores + triggers a sync. The dialog opens on a 401 from Share/Join, or from the home menu item "Mot de passe du serveur" (a global `ardoise:auth-required` window event, listened for in App).
- **Why app-level not Caddy basic-auth**: user wanted enter-once + permanent browser storage + the static PWA still loading; basic-auth re-prompts with the native dialog and gates the whole site. App-level gates sync only.
- *Rationale*: "not everyone can pull/push" for a small friends group; a shared password is proportionate (no per-user accounts). Background sync swallows 401 silently (no nagging); only explicit actions open the gate.
- *Status*: active. Verified live: with `API_KEY` set, `auth-check`/`register`/`push`/`pull` return 401 without/with-wrong key and 200 with the right key; `ping` stays open. 20 backend tests (7 auth) + 79 FE tests pass. `API_KEY` left empty in the repo's dev env; production sets it (see [DEPLOY.md](../DEPLOY.md)).
