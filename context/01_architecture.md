# 01 - Architecture (current state)

## Guiding principles

1. **Local-first.** The device IndexedDB is the source of truth. The UI never waits on the network. The server is a sync/backup relay, not a gatekeeper.
2. **Conflict-free by design.** Many people edit one group from many devices, often offline. An append-only operation log makes merges deterministic and lossless (see [02_sync-and-offline.md](02_sync-and-offline.md)).
3. **You own the data.** Self-hosted backend on the homelab. One-tap export to CSV/JSON. No third party, no analytics.
4. **Reuse VroomVroom muscle memory.** Same core stack. The only genuinely new pieces are Dexie (IndexedDB) and the sync engine.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + TS + Vite + Tailwind v4 + shadcn/ui + dexie-react-hooks | Same as VroomVroom, minus TanStack Query: data is local-first, Dexie live queries cover it |
| Local store | **Dexie.js** (IndexedDB) | Offline source of truth: holds folded state cache + op log |
| PWA / SW | **vite-plugin-pwa** (Workbox) | Replaces hand-rolled sw.js: precache, update flow, Background Sync where supported |
| Backend | FastAPI + SQLAlchemy 2.0 + Pydantic 2 + Alembic | Same as VroomVroom |
| DB | MariaDB (or Postgres) | Same as VroomVroom; op log is a simple append table |
| Auth / sharing | **Share-code join** (see 03, decision D6) | Low friction for "me + friends/household" |
| Deploy | Docker Compose on homelab, reverse proxy, `*.home.ouiouibaguette.fr` | Same as VroomVroom |

## Domain model

```
Group (a "tricount")
  id (uuid), name, currency, created_at, share_code

Member (participant, need NOT be an app user; just a name, like Tricount)
  id (uuid), group_id, display_name, created_at, deleted

Expense
  id (uuid), group_id, description, amount_cents, currency,
  paid_by (member_id), spent_at (date), emoji, split_mode, created_at, deleted

ExpenseShare (how one expense is split)
  expense_id, member_id, weight  (equal split = weight 1 each;
                                   or exact cents; or percentage)

Settlement (a real payback "X paid Y 20 EUR")
  id (uuid), group_id, from_member, to_member, amount_cents, settled_at
```

Two computed (not stored) outputs:
- **Balances**: per member, sum(paid) minus sum(owed). Must net to zero.
- **Who-pays-whom**: the *simplify debts* algorithm (greedy min-cash-flow), match biggest creditor with biggest debtor until settled. Minimises the number of transfers.

All money is stored in **integer cents** (never floats). Splits that do not divide evenly distribute the remainder cent by cent deterministically (first N members get +1 cent). See decision D7.

## Project structure

```
tricount-clone/
├── context/                 # this folder (decisions + current-state docs)
├── backend/                 # mirrors VroomVroom layout
│   └── app/
│       ├── main.py
│       ├── api/v1/endpoints/{groups,ops,export}.py
│       ├── models/{group,member,expense,operation,settlement}.py
│       ├── schemas/...
│       ├── services/{group_service,sync_service,balance_service}.py
│       └── core/{config,database}.py
├── frontend-react/
│   └── src/
│       ├── db/dexie.ts               # IndexedDB schema (state cache + op log)
│       ├── sync/{engine.ts,ops.ts}   # generate ops, push/pull, fold
│       ├── domain/{balances.ts,simplify-debts.ts,split.ts}  # pure, unit-tested
│       ├── hooks/{use-group,use-expenses,use-sync}.ts
│       ├── components/{expense,group,balance,ui}/
│       └── pages/{Groups,GroupDetail,AddExpense,Balances,Settle}.tsx
└── docker-compose.yml
```

The `domain/` folder is **pure functions** (split maths, balances, simplify-debts) with heavy unit tests. This is where money bugs live, so it is the most-tested code in the app.
