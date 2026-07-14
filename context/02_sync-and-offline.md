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

- **Push**: `POST /groups/{id}/ops` with local ops the server has not ack'd, in batches of 500 (`PUSH_BATCH`) so a huge catch-up never trips the proxy's body-size limit. Server stores them idempotently (unique `op_id`), returns the new server cursor.
- **Pull**: `GET /groups/{id}/ops?since={cursor}` returns ops from other devices plus the group's REAL max seq (even when empty). Client folds them into Dexie.
- The server **only appends and serves ops**. It never merges or decides. All devices compute the same state from the same ops.
- Every request carries a 15s abort timeout so a half-open connection can never wedge the sync engine.

## Self-healing: the server is disposable

The devices hold the full log, so any server-side data loss is recoverable from the phones, automatically:

- **404 on push/pull** (DB wiped/recreated): the client re-registers the same group id, marks its whole local log unsynced, resets the cursor, and re-pushes everything. Each device heals itself the same way; the server converges back to the union of everyone's history. A new share code may be minted (old invite links die; the app shows the current code in Partager).
- **Pull cursor below ours** (DB restored from an older backup): the client detects the rewind and does the same reset-and-reseed, restoring the ops the backup lost.

Both paths are idempotent (`op_id` dedup) and covered by engine tests (wipe and rewind scenarios).

## When does sync run? (iOS reality check)

- On app foreground, on the `online` event, and on a light interval while open (same trigger model as VroomVroom `use-offline.ts`).
- iOS Safari has **no reliable Background Sync API**, so we do not depend on it. Sync is opportunistic while the app is open. Android gets Background Sync as a bonus via Workbox.
- Call `navigator.storage.persist()` on first launch so iOS does not evict IndexedDB after 7 idle days.
- Everything works with zero connectivity; sync is pure catch-up.

## Push notifications (D30, message shape D31)

The relay is also the natural fan-out point: when a device pushes new ops, the
server notifies every subscribed device following that group, except the
author's own (`device_id == actor`). Batches above 50 accepted ops stay silent
(that is a self-heal reseed or an import, not live activity). The custom
service worker ([src/sw.ts](../frontend-react/src/sw.ts), injectManifest) shows
the notification and opens the group on tap. Subscriptions are device-scoped
(like identity, D23) and carry the device's shared-group list, re-sent on app
start and after share/join/leave. Requires `VAPID_PRIVATE_KEY` server-side;
without it push is cleanly off and the menu entry hides.

Message shape (D31): **title = the group's name**, body = what happened,
including on deletion ("Depense supprimee : Pizza", "Participant retire :
Sarah"). A delete op has an empty payload, so `build_body` resolves names via
`_latest_payload_field`, a display-only lookup over the entity's earlier ops
in fold order; the server still never folds state. Multi-op batches collapse
to "N modifications" under the group-name title.

## Known iOS PWA constraints (designed around, not fought)

- Must be **Add-to-Home-Screen** for standalone mode and any push.
- **No Background Sync**, so sync only while the app is open (acceptable; we never block the UI).
- IndexedDB can be **evicted after 7 idle days**, so call `navigator.storage.persist()`.
- **Web Push** works on iOS 16.4+ but only when installed to home screen (D30); in Safari-the-tab the menu points to the install steps first.
- No true background anything, so the op-log-on-foreground model sidesteps all of it.
