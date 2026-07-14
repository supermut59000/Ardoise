# 02 - Sync and offline (current state)

This is the core of the "as resilient as possible" requirement.

## Why not just a write queue like VroomVroom?

VroomVroom has a single writer (you) editing your own vehicles, so a localStorage queue is enough. A Tricount is **many writers on one shared group**. If Alice edits an expense offline while Bob deletes it offline, a naive queue corrupts or loses data. We need real merge semantics. See decision D5.

## Design: append-only operation log

Every change is an immutable **operation**, generated locally, never mutated:

```
Operation
  op_id (uuid, client-generated)
  group_id
  entity      ("expense" | "member" | "settlement" | "group")
  entity_id   (uuid of the thing being changed)
  action      ("create" | "update" | "delete")
  payload     (json, the fields set by this op)
  actor       (device/member id)
  lamport     (logical clock, for deterministic ordering)
  created_at  (wall clock, tiebreak + display)
```

- **State = fold(operations).** Current group state is derived by replaying ops in `(lamport, op_id)` order. Dexie caches the folded state so UI reads are instant; the op log is the truth.
- **Adds are commutative**, so two people adding expenses offline never conflict.
- **Edits/deletes use last-writer-wins per field** by `(lamport, op_id)`. Deterministic on every device, so everyone converges to the same state.
- **Delete beats concurrent edit** (tombstone wins), matching user intent ("I removed this").

## Sync protocol (stateless server)

- **Push**: `POST /groups/{id}/ops` with all local ops the server has not ack'd. Server stores them idempotently (unique `op_id`), returns the new server cursor.
- **Pull**: `GET /groups/{id}/ops?since={cursor}` returns ops from other devices. Client folds them into Dexie.
- The server **only appends and serves ops**. It never merges or decides. All devices compute the same state from the same ops.

## When does sync run? (iOS reality check)

- On app foreground, on the `online` event, and on a light interval while open (same trigger model as VroomVroom `use-offline.ts`).
- iOS Safari has **no reliable Background Sync API**, so we do not depend on it. Sync is opportunistic while the app is open. Android gets Background Sync as a bonus via Workbox.
- Call `navigator.storage.persist()` on first launch so iOS does not evict IndexedDB after 7 idle days.
- Everything works with zero connectivity; sync is pure catch-up.

## Known iOS PWA constraints (designed around, not fought)

- Must be **Add-to-Home-Screen** for standalone mode and any push.
- **No Background Sync**, so sync only while the app is open (acceptable; we never block the UI).
- IndexedDB can be **evicted after 7 idle days**, so call `navigator.storage.persist()`.
- **Web Push** only iOS 16.4+ and only when installed to home screen, so reminders are a nice-to-have, not core.
- No true background anything, so the op-log-on-foreground model sidesteps all of it.
