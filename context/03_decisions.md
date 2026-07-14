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

### D22 - 2026-07-14 - App-audit fixes + "better than Tricount" polish

Ran `/app-audit`; fixed the top findings and added two UX wins. User direction: they are the only technical user, friends must never see raw errors, and it should beat Tricount on sync speed + clarity.
- **S1 (security, fixed)**: docker-compose now binds backend + frontend to `127.0.0.1` and does not publish MariaDB at all. Docker bypasses UFW when publishing, so the previous `0.0.0.0` binds could have exposed the DB (default creds) to the internet despite Caddy. Verified live: port 3307 refused, app still served, DB reachable via the compose network.
- **S2 (security, fixed)**: `.env.docker` defaults to `DEBUG=false` (+ `ENVIRONMENT=production`), so Swagger `/docs` and `/api/v1/openapi.json` are off in prod. Verified: both now 404.
- **B1 (bug, fixed)**: deleting a participant referenced by a depense/remboursement created a nameless ghost in balances. Added `referencedMemberIds` ([domain/balances.ts](../frontend-react/src/domain/balances.ts)); [ParticipantsDialog](../frontend-react/src/components/group/ParticipantsDialog.tsx) blocks removing a referenced member (friendly toast, dimmed control), and `nameOf` degrades to "Ancien participant" (never "?") for any id removed on another device.
- **F1 (flow, fixed)**: sync no longer fails silently. `syncAllGroups` returns `{authError, networkError}`; `countUnsyncedShared` counts pending ops; [use-sync](../frontend-react/src/hooks/use-sync.ts) surfaces `pending` in [SyncBar](../frontend-react/src/components/layout/SyncBar.tsx) ("N modifications en attente") and auto-opens the password dialog on a persistent 401 (throttled to once/min). No raw errors, matching the "friends" constraint.
- **Sync speed (better-than-Tricount)**: local writes emit `ardoise:local-change` ([sync/events.ts](../frontend-react/src/sync/events.ts)); use-sync debounces a push ~800ms after an edit and polls every 20s (was 30s), so changes reach friends in ~1s instead of up to 30s.
- **Accepted risks (re-confirmed, do not re-propose as bugs)**: S3 no rate limiting, S4 no per-group authz / no payload-size cap, S5 default DB password. All documented in [DEPLOY.md](../DEPLOY.md) as deliberate for a trusted-friends instance. Mitigations noted (strong API_KEY, optional Caddy rate-limit / body-size limit).
- *Status*: active. Verified: 85 FE + 20 backend tests, tsc + build clean, all four fixes checked live. Not click-tested in a browser.

### D23 - 2026-07-14 - UX pass for non-technical users (identity, undo, group/member management)

Continuation of the "smoother than Tricount" direction, focused on removing dead ends and irreversible mistakes:
- **Per-group identity ("Qui etes-vous ?")**: [lib/me.ts](../frontend-react/src/lib/me.ts) stores a groupId -> memberId map in localStorage (device-local, never synced: identity belongs to the device, not the shared data; reactive via useSyncExternalStore). Set from a labeled select in [ParticipantsDialog](../frontend-react/src/components/group/ParticipantsDialog.tsx). Effects: ExpenseForm preselects the payer, the Soldes tab shows a personal headline card ("On vous doit X" / "Vous devez X" / "Vous etes a jour") and "(moi)" suffixes on balance/transfer/settlement lines. Cleared automatically if that member is removed.
- **Undo after expense delete**: swipe-delete and edit-page delete both show a toast with an "Annuler" action that re-creates the expense with the same content but a new id, because a delete op is terminal in the fold (D15) and the original id cannot be resurrected. Chosen over a confirm dialog: keeps the fast path fast, still recoverable.
- **Group rename + delete shipped** (ops existed since Phase 1, UI was missing): [RenameGroupDialog](../frontend-react/src/components/group/RenameGroupDialog.tsx) replaces the disabled "bientot" menu item; [DeleteGroupDialog](../frontend-react/src/components/group/DeleteGroupDialog.tsx) is a destructive menu item with a confirm dialog whose wording is shared-aware ("supprime pour tous les participants" via isShared, since the delete op propagates to every device).
- **Participant rename** in ParticipantsDialog (pencil -> inline input): fixes the permanent-typo trap, since a member referenced by expenses cannot be removed and re-added. The add-participant input no longer autofocuses (the dialog is now also for renaming and identity, so popping the mobile keyboard on open was wrong).
- **Checklist polish**: cursor-pointer + transition-colors on the split-mode picker, dialog icon buttons, and the share-code copy button.
- *Status*: active. Verified: tsc clean, 85 FE tests pass, build emits SW. Not click-tested in a browser.

### D24 - 2026-07-14 - Expense emojis with fuzzy picker and auto-suggestion ("more lively")

User feedback: friends found the app visually dead. Expenses now carry an optional emoji.
- **Data**: `emoji?: string` on Expense ('' or absent = none). It is an ordinary payload field, so fold LWW, sync and the relay need zero changes; old expenses render as before. The form always writes the field (even empty) so clearing an emoji syncs.
- **Catalogue + search** ([lib/emoji.ts](../frontend-react/src/lib/emoji.ts)): ~130 curated expense emojis with unaccented French keywords (brands included: mcdo, carrefour, uber, sncf, blablacar...). `searchEmojis` ranks exact > prefix > substring, accent-insensitive. `suggestEmoji` proposes one from the description live (whole-word or word-prefix, words >= 3 letters so noise never triggers).
- **UI**: emoji button next to the description field opens [EmojiPickerDialog](../frontend-react/src/components/expense/EmojiPickerDialog.tsx) (search input + grid + "Retirer l'emoji"). Typing a description auto-fills the emoji until the user picks one manually (then suggestions stop for that expense). Expense rows show the emoji in a rounded tile with the payer's avatar as a corner badge; rows without emoji keep the plain avatar.
- **Note**: the "no emoji as UI icons" rule still holds; these emojis are user content (a category marker on a depense), not interface iconography.
- *Status*: active. Verified: tsc clean, 98 FE tests (13 new for normalize/search/suggest), build emits SW. Not click-tested in a browser.

### D25 - 2026-07-14 - "Ma part" on the total card, themed Select, LAN-exposed frontend port

- **Ma part**: when the local user has set their identity (D23), the "Total des depenses" card shows a second line with their own share of consumption. New pure helper `memberShareCents(expenses, memberId)` in [domain/balances.ts](../frontend-react/src/domain/balances.ts) (sums computeOwed per expense, so remainder-exact; property test: member shares sum to the group total).
- **Select component** ([components/ui/select.tsx](../frontend-react/src/components/ui/select.tsx)): shared themed native select replacing the two ad-hoc `<select>`s (payer, "Qui etes-vous ?"). Explicit `bg-background text-foreground` (never the UA default white in dark mode) plus themed `<option>`s where browsers allow; `color-scheme` in index.css still covers OS-rendered popups. User-reported dark-mode fix.
- **Frontend port binding**: user changed `127.0.0.1:3060:80` to `3060:80` in docker-compose because Caddy runs in a different LXC than the app. Backend (8065) and MariaDB stay loopback/unpublished; the LAN can reach the frontend but sync remains gated by API_KEY. Comment updated to match.
- *Status*: active. Verified: tsc clean, 103 FE tests, build emits SW. Not click-tested in a browser.

### D26 - 2026-07-14 - Visual polish pass (senior UI review items 1-8)

Eight look-and-feel changes from a design review, no behaviour change:
- **Balance bars**: the Soldes tab renders a center-axis bar per member (rose grows left = owes, emerald grows right = is owed), scaled to the group's largest absolute balance. Pure CSS, no lib.
- **Layered light mode**: `--background` is now a faint indigo-tinted grey (oklch 0.977) with pure white cards on top; `--muted`/`--secondary` deepened slightly to stay visible; segmented-control thumbs switched from bg-background to bg-card so they stay white.
- **Typeface**: self-hosted **Lexend Variable** via `@fontsource-variable/lexend` (bundled + SW-precached, so offline holds; import must be `/index.css`, the bare specifier has no TS types). System stack kept as fallback.
- **Hero total card**: brand gradient `from-primary to-[var(--primary-deep)]` (new `--primary-deep` var in both modes), rounded-2xl, colored shadow.
- **PWA chrome**: `theme-color` now matches the indigo brand (#4d5ce0) with a dark-mode media variant (#0a0a0a); manifest `theme_color` updated. Splash `background_color` untouched.
- **Home group cards**: 1.5px-wide accent edge colored by `avatarColor(group.id)` (same hash as member avatars) + up to 3 recent distinct expense emojis in the subtitle (`recentEmojis` added to GroupSummary).
- **Day grouping**: expense list gets section headers via new pure `dayLabel(iso, today)` in [lib/format.ts](../frontend-react/src/lib/format.ts) ("Aujourd'hui", "Hier", "1 juillet", year appended cross-year; unit-tested incl. year boundary). The per-row date was removed as redundant.
- **Motion**: tab panels animate in (tw-animate-css fade+slide, 300ms); balance bars animate width. Global prefers-reduced-motion kill-switch already covers these.
- *Status*: active. Verified: tsc clean, 108 FE tests, build emits SW (font precached, 12 entries). Not click-tested in a browser.

### D27 - 2026-07-14 - Device-feedback fixes: FAB safe-area, French date field

From real-device screenshots:
- **FAB clipped**: fixed elements ignore the body's safe-area padding, so the add-expense button sat half under the home-indicator zone. Its bottom offset is now `calc(1.5rem + env(safe-area-inset-bottom))`.
- **Date input showed US format**: a native `<input type=date>` renders in the browser locale ("03/25/2026" on an English phone), ignoring the page's `lang="fr"`. New [DateField](../frontend-react/src/components/ui/date-field.tsx): the real input sits invisible on top (native picker, focus and keyboard all keep working) over a styled layer that renders `dayLabel(value)`, so it reads "Aujourd'hui" / "Hier" / "25 mars" everywhere.
- *Status*: active. Verified: tsc clean, 108 FE tests, build emits SW. Not click-tested in a browser.

### D28 - 2026-07-14 - dayLabel always carries the year; FAB stacked above rows

Refinement of D26/D27 after user feedback: `dayLabel` full dates now always include the year ("25 mars 2026", not only cross-year), and the add-expense FAB gets `z-40` so it always paints above the expense rows (SwipeableCard transforms create their own stacking contexts).
- *Status*: active. Verified: tsc clean, 107 FE tests (two dayLabel cases merged into one), build emits SW.

### D29 - 2026-07-14 - Second audit: self-healing sync, resilience fixes, import + leave-group

Second `/app-audit` pass focused on "bulletproof regardless of homelab/network/device". All flow findings fixed, plus the date bug and two features. User skipped the DB-backup suggestion (already has a 3-2-1 backup that stops containers and copies their folders).

**Self-healing sync (the big one)**: the devices hold the full op log, the server is disposable, and sync now acts on it ([engine.ts](../frontend-react/src/sync/engine.ts)):
- Push/pull 404 (server DB wiped or recreated): the client re-registers the same groupId (a new share code may be minted), marks the whole local log unsynced, resets the cursor, and re-pushes everything. Every device heals the same way, so the server converges back to the union of everyone's history. Previously this state was a silent, permanent sync failure and even manual re-sharing produced an empty group (all ops were already flagged synced).
- Pull cursor BELOW ours (server restored from an older backup): [sync_service.pull](../backend/app/services/sync_service.py) now returns the group's real max seq on an empty pull instead of echoing `since`; the client detects `cursor < state.cursor` and re-seeds the same way. Previously peers' new ops under the old cursor were silently never pulled (permanent divergence).
- One heal attempt per sync pass (`healed` flag); the 20s tick retries anyway.

**Resilience fixes**:
- Requests carry `AbortSignal.timeout(15s)` ([client.ts](../frontend-react/src/sync/client.ts)); a half-open connection used to leave `running.current` locked forever, freezing sync until app restart.
- Pushes are batched (`PUSH_BATCH = 500` ops per request) and nginx got `client_max_body_size 10m`; a giant first push used to 413 and retry the same oversized body forever.
- `use-sync` no longer gates on `navigator.onLine` (misreporting WebViews); it just tries and lets fetch fail. `online` only drives the SyncBar.
- PWA `registerType` switched from `autoUpdate` to `prompt`: autoUpdate never fires `needRefresh` (the PwaPrompt toast was dead code) and force-reloads the page on SW activation, losing any in-progress form. Now the toast works as designed.
- Invite-link first run: a join interrupted by the password gate is remembered and retried automatically after the key is accepted (`AUTH_SUCCESS_EVENT` in [auth.ts](../frontend-react/src/lib/auth.ts), retry in [Groups.tsx](../frontend-react/src/pages/Groups.tsx)); the code is also prefilled in the join input. Previously the code was lost and the friend landed on an empty home screen.
- "Regler" is disabled while the settlement op writes (double-tap recorded it twice).
- `/health` returns 503 when the DB is unreachable (was HTTP 200 with an "unhealthy" body, which kept the Docker healthcheck green during an outage).

**Bug**: `todayIso()` now builds the date from local components. `toISOString()` is UTC, so from midnight to 2am Paris time, new expenses and settlements were dated yesterday.

**Features**:
- **Import JSON by replay** ([export.ts](../frontend-react/src/lib/export.ts) `parseJsonExport`/`importJsonExport`, menu item on the home screen): validates the envelope (French error if not an Ardoise export), skips malformed entries with a count, ignores ops already present, marks imported ops unsynced so shared groups re-push them (server dedups by opId, so importing is always safe). This makes DEPLOY.md's "re-import by replay" claim real.
- **Quitter le groupe (cet appareil)** ([LeaveGroupDialog](../frontend-react/src/components/group/LeaveGroupDialog.tsx), `leaveGroup` in engine): device-local removal for SHARED groups only (a local-only group's data exists nowhere else, so its only removal stays the real delete). Warns when unsynced ops would be lost. Re-joining by code restores the group in full. Previously a friend could only declutter by deleting the group for everyone.

**Deliberately NOT built**: automated DB backup (user's 3-2-1 setup covers it); web-push notifications stay skipped for now (asked about, answered: possible on Android + iOS 16.4+ installed PWAs, but needs VAPID keys, a subscription store and a push sender server-side; to revisit only if the user asks).

- *Status*: active. Verified: tsc clean, 117 FE tests (10 new: wipe-heal, rewind-reseed, batching, leaveGroup, import round-trip/rejects/idempotence, todayIso timezone x2), 22 backend tests (2 new: rewind cursor, health 503) via the container, `vite build` emits the SW, `nginx -t` passes. Backend test deps documented in [requirements-dev.txt](../backend/requirements-dev.txt) (pytest was never in the image; the docs claimed a command that could not run as written). Not click-tested in a browser.

### D30 - 2026-07-14 - Web Push notifications (Android, iOS 16.4+ installed, desktop)

User decision: notifications are core to the "feels like a real app" goal, explicitly overriding the Phase 4 "web-push reminders: skipped" call. Not reminders: activity alerts ("Nouvelle depense : Pizza : 18,00 EUR") when someone else changes a shared group.

- **Server** (still holds no folded state; messages are built from op payloads alone):
  - `push_subscriptions` table (endpoint PK, p256dh/auth keys, device_id, group_ids JSON), migration `a71f3b9d02e4`.
  - [push_service.py](../backend/app/services/push_service.py): `build_message` (French, per entity/action, batches collapse to "N modifications"), `notify_group` fan-out that SKIPS the author's own device (`device_id == op actor`) and prunes dead subscriptions on 404/410 from the push service. pywebpush imported lazily so old images still boot.
  - Endpoints under `/push` behind the same X-API-Key gate: `vapid-public-key`, `subscribe` (idempotent upsert by endpoint), `unsubscribe`. All answer 503 when `VAPID_PRIVATE_KEY` is unset (push cleanly disabled; the client hides the menu entry).
  - The sync push endpoint schedules the fan-out as a FastAPI BackgroundTask (own DB session, never delays sync) and stays silent above `NOTIFY_MAX_BATCH = 50` accepted ops (a self-heal reseed or import replay is not live activity).
  - Config: `VAPID_PRIVATE_KEY` (raw base64url, generated by the DEPLOY.md one-liner; rotating it invalidates every subscription), `VAPID_SUBJECT`. `pywebpush==2.0.3` pinned.
- **Client**:
  - vite-plugin-pwa switched from `generateSW` to `strategies: 'injectManifest'` with a custom [src/sw.ts](../frontend-react/src/sw.ts): identical precache + SPA fallback + SKIP_WAITING prompt flow, plus `push` (always calls showNotification: iOS revokes subscriptions whose pushes stay invisible; `tag` per group collapses piles) and `notificationclick` (opens/focuses the group page). workbox-precaching/-routing added as devDeps.
  - [lib/push.ts](../frontend-react/src/lib/push.ts): enable/disable (permission request from the menu tap, a user gesture, as iOS requires), subscription POSTed with the device id + shared-group list; `syncPushGroups()` re-sends the list on app start and after share/join/leave. Device-scoped like identity (D23), never in the op log.
  - [use-push](../frontend-react/src/hooks/use-push.ts) + home menu: "Activer/Desactiver les notifications"; on iOS-in-Safari (no PushManager until installed) the entry becomes "Notifications (installer l'app d'abord)" and opens the install helper. 401 opens the password dialog; 503 explains the server has no key.
- **Platform truth**: Android/Chromium and desktop full support; iOS 16.4+ only as an installed home-screen app; no support = hidden. The author never gets notified about their own edit.
- *Status*: active. Verified: 119 FE tests (12 files) incl. base64url decoding, 32 backend tests incl. fan-out/author-exclusion/pruning/silence-above-cap/503-when-disabled, tsc clean, build emits the custom sw.js (injectManifest, 12 precache entries), VAPID generate + derive round-trip proven live in the container. Needs at deploy: image rebuild (pywebpush), `alembic upgrade head`, VAPID key in `.env` (DEPLOY.md section 2). Not click-tested in a browser.
