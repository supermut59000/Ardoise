//! SQLite storage layer. One writer + a small read-only pool behind
//! tokio::sync::Mutex (WAL mode: N readers + 1 writer, readers never block
//! the writer).
//! The locks are async so a contended wait queues the task instead of
//! parking a worker thread in a blocking std lock — that stall starved the
//! event loop at ~14k concurrent users (loadtest 2026-09-19).
//! Readers are fixed slots, each its own mutex: a slot is always released
//! by the guard's Drop, even if the task is cancelled mid-query. The old
//! pop/push design leaked a connection on cancellation and drained the
//! pool when a mass of clients disconnected at once (loadtest 2026-09-26).
//! ponytail: 8 fixed slots; bump READERS if reads ever contend.

use anyhow::Result;
use rand::rngs::OsRng;
use rand::Rng;
use rusqlite::{params, Connection, OpenFlags};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use crate::wire::OperationWire;

pub struct Group {
    pub id: String,
    pub share_code: String,
}

pub struct Sub {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub device_id: String,
    pub group_ids: Vec<String>,
}

/// Unambiguous alphabet (no 0/O/1/I/L), matches the Python generator.
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn generate_code() -> String {
    let mut rng = OsRng;
    (0..8)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

const READERS: usize = 8;

#[derive(Clone)]
pub struct Db {
    writer: Arc<Mutex<Connection>>,
    readers: Vec<Arc<Mutex<Connection>>>,
    next: Arc<AtomicU64>,
}

pub fn open(path: &str) -> Result<Db> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_millis(5_000))?;
    // WAL: readers never block the writer (polls every 20 s vs pushes).
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(
        "-- Mirrors backend/alembic/versions (MariaDB -> SQLite types).
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            share_code TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ix_groups_share_code ON groups (share_code);
        CREATE TABLE IF NOT EXISTS operations (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            op_id TEXT NOT NULL,
            group_id TEXT NOT NULL,
            entity TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            payload TEXT NOT NULL,
            actor TEXT NOT NULL,
            lamport INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            received_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ix_operations_op_id ON operations (op_id);
        CREATE INDEX IF NOT EXISTS ix_operations_group_id ON operations (group_id);
        CREATE INDEX IF NOT EXISTS ix_operations_group_seq ON operations (group_id, seq);
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            device_id TEXT NOT NULL,
            group_ids TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_push_subscriptions_device_id ON push_subscriptions (device_id);
        CREATE TABLE IF NOT EXISTS server_meta (
            id INTEGER PRIMARY KEY,
            generation TEXT NOT NULL
        );",
    )?;
    // Read-only pool: WAL serves these alongside the single writer.
    let readers: Vec<Arc<Mutex<Connection>>> = (0..READERS)
        .map(|_| {
            let r = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            r.busy_timeout(Duration::from_millis(5_000))?;
            Ok(Arc::new(Mutex::new(r)))
        })
        .collect::<Result<_>>()?;
    Ok(Db {
        writer: Arc::new(Mutex::new(conn)),
        readers,
        next: Arc::new(AtomicU64::new(0)),
    })
}

impl Db {
    /// Run `f` on a round-robin read-only slot. The slot's mutex guard is
    /// released on drop — a cancelled task never loses the connection.
    async fn with_reader<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let slot = &self.readers[self.next.fetch_add(1, Ordering::Relaxed) as usize % READERS];
        let guard = slot.lock().await;
        f(&guard)
    }

    /// Stable for one DB lifetime; a wiped DB gets a fresh generation.
    pub async fn server_generation(&self) -> Result<String> {
        let conn = self.writer.lock().await;
        let row: Option<String> = conn
            .query_row("SELECT generation FROM server_meta WHERE id = 1", [], |r| r.get(0))
            .ok();
        match row {
            Some(g) => Ok(g),
            None => {
                let g = uuid::Uuid::new_v4().to_string();
                conn.execute("INSERT INTO server_meta (id, generation) VALUES (1, ?1)", params![g])?;
                Ok(g)
            }
        }
    }

    pub async fn health(&self) -> bool {
        self.with_reader(|c| { c.execute_batch("SELECT 1")?; Ok(()) }).await.is_ok()
    }

    pub async fn get_group(&self, id: &str) -> Result<Option<Group>> {
        self.with_reader(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, share_code FROM groups WHERE id = ?1",
                    params![id],
                    |r| Ok(Group { id: r.get(0)?, share_code: r.get(1)? }),
                )
                .ok())
        }).await
    }

    /// Idempotent register; retry on the astronomically unlikely code collision.
    pub async fn register_group(&self, id: &str) -> Result<Group> {
        if let Some(g) = self.get_group(id).await? {
            return Ok(g);
        }
        let conn = self.writer.lock().await;
        for _ in 0..10 {
            let code = generate_code();
            let taken: i64 = conn.query_row(
                "SELECT COUNT(*) FROM groups WHERE share_code = ?1",
                params![code],
                |r| r.get(0),
            )?;
            if taken == 0 {
                conn.execute(
                    "INSERT INTO groups (id, share_code, created_at) VALUES (?1, ?2, ?3)",
                    params![id, code, now_ms()],
                )?;
                return Ok(Group { id: id.into(), share_code: code });
            }
        }
        anyhow::bail!("Could not allocate a unique share code")
    }

    /// Share codes are case-insensitive on resolve (Python does .upper()).
    pub async fn resolve_code(&self, code: &str) -> Result<Option<Group>> {
        self.with_reader(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, share_code FROM groups WHERE share_code = ?1",
                    params![code.to_uppercase()],
                    |r| Ok(Group { id: r.get(0)?, share_code: r.get(1)? }),
                )
                .ok())
        }).await
    }

    fn max_cursor(conn: &Connection, group_id: &str) -> Result<i64> {
        let v: Option<i64> = conn.query_row(
            "SELECT MAX(seq) FROM operations WHERE group_id = ?1",
            params![group_id],
            |r| r.get(0),
        )?;
        Ok(v.unwrap_or(0))
    }

    /// Store incoming ops idempotently (dedup by op_id, incl. within-batch).
    /// Returns (accepted ops, current max cursor). Never mutates existing rows.
    pub async fn push_ops(&self, group_id: &str, ops: &[OperationWire]) -> Result<(Vec<OperationWire>, i64)> {
        let conn = self.writer.lock().await;
        Self::push_into(&conn, group_id, ops)
    }

    fn push_into(conn: &Connection, group_id: &str, ops: &[OperationWire]) -> Result<(Vec<OperationWire>, i64)> {
        if ops.is_empty() {
            return Ok((Vec::new(), Self::max_cursor(conn, group_id)?));
        }
        // Existing op_ids among the incoming batch.
        let mut existing: std::collections::HashSet<&str> = std::collections::HashSet::new();
        {
            let mut stmt = conn.prepare("SELECT op_id FROM operations WHERE op_id = ?1")?;
            for o in ops {
                let exists: bool = stmt
                    .query_row(params![o.op_id], |r| r.get::<_, Option<String>>(0))
                    .map(|v| v.is_some())
                    .unwrap_or(false);
                if exists {
                    existing.insert(&o.op_id);
                }
            }
        }
        let tx = conn.unchecked_transaction()?;
        let mut ins = tx.prepare(
            "INSERT INTO operations (op_id, group_id, entity, entity_id, action, payload, actor, lamport, created_at, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        let mut accepted: Vec<OperationWire> = Vec::new();
        for o in ops {
            if existing.contains(o.op_id.as_str()) {
                continue; // duplicate: server append-only, no overwrite
            }
            ins.execute(params![
                o.op_id,
                group_id,
                o.entity,
                o.entity_id,
                o.action,
                serde_json::to_string(&o.payload)?,
                o.actor,
                o.lamport as i64,
                o.created_at as i64,
                now_ms(),
            ])?;
            existing.insert(&o.op_id); // guard against duplicates within one request
            accepted.push(o.clone());
        }
        drop(ins); // end the borrow before committing the transaction
        tx.commit()?;
        Ok((accepted, Self::max_cursor(&conn, group_id)?))
    }

    /// Ops with seq > since in seq order. Empty result returns the REAL max
    /// cursor (a client whose cursor is ahead of the server — DB restored from
    /// an older backup — sees cursor < since and knows to reset and re-sync).
    pub async fn pull_ops(&self, group_id: &str, since: i64) -> Result<(Vec<OperationWire>, i64)> {
        self.with_reader(|conn| Self::pull_from(conn, group_id, since)).await
    }

    fn pull_from(conn: &Connection, group_id: &str, since: i64) -> Result<(Vec<OperationWire>, i64)> {
        let mut stmt = conn.prepare(
            "SELECT seq, op_id, group_id, entity, entity_id, action, payload, actor, lamport, created_at
             FROM operations WHERE group_id = ?1 AND seq > ?2 ORDER BY seq ASC",
        )?;
        let it = stmt
            .query_map(params![group_id, since], |r| {
                let payload: String = r.get(6)?;
                Ok((
                    r.get::<_, i64>(0)?,
                    OperationWire {
                        op_id: r.get(1)?,
                        group_id: r.get(2)?,
                        entity: r.get(3)?,
                        entity_id: r.get(4)?,
                        action: r.get(5)?,
                        payload: serde_json::from_str(&payload)
                            .unwrap_or_else(|_| serde_json::Value::Object(Default::default())),
                        actor: r.get(7)?,
                        lamport: r.get::<_, i64>(8)? as u64,
                        created_at: r.get::<_, i64>(9)? as u64,
                    },
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // Window is a suffix in seq order: cursor = last row's seq, or the
        // group's real max when the window is empty (self-heal signal).
        let cursor = match it.last().map(|(s, _)| *s) {
            Some(s) => s,
            None => Self::max_cursor(&conn, group_id)?,
        };
        Ok((it.into_iter().map(|(_, w)| w).collect(), cursor))
    }

    /// Push + pull in ONE round trip (one client round trip): applies `ops`
    /// idempotently, then returns (accepted ops, everything with seq >
    /// `since`, cursor) — the accepted ops come back too, so the caller can
    /// drive the notification fan-out exactly like a plain push. Atomic: a
    /// concurrent push cannot slip in between our insert and our read (a torn
    /// window would hand a client a cursor that skips rows).
    /// Steady-state syncs mostly carry no ops — that path is a pure pull and
    /// runs on a read-pool slot instead of the writer.
    pub async fn sync_ops(
        &self,
        group_id: &str,
        ops: &[OperationWire],
        since: i64,
    ) -> Result<(Vec<OperationWire>, Vec<OperationWire>, i64)> {
        if ops.is_empty() {
            let (rows, cursor) = self.with_reader(|conn| Self::pull_from(conn, group_id, since)).await?;
            return Ok((Vec::new(), rows, cursor));
        }
        let conn = self.writer.lock().await;
        let (accepted, _) = Self::push_into(&conn, group_id, ops)?;
        let (rows, cursor) = Self::pull_from(&conn, group_id, since)?;
        Ok((accepted, rows, cursor))
    }

    pub async fn upsert_sub(&self, s: &Sub) -> Result<()> {
        let conn = self.writer.lock().await;
        conn.execute(
            "INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_id, group_ids, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(endpoint) DO UPDATE SET p256dh=?2, auth=?3, device_id=?4, group_ids=?5, updated_at=?6",
            params![
                s.endpoint,
                s.p256dh,
                s.auth,
                s.device_id,
                serde_json::to_string(&s.group_ids)?,
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub async fn delete_sub(&self, endpoint: &str) -> Result<()> {
        let conn = self.writer.lock().await;
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?1", params![endpoint])?;
        Ok(())
    }

    pub async fn list_subs(&self) -> Result<Vec<Sub>> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT endpoint, p256dh, auth, device_id, group_ids FROM push_subscriptions",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    let g: String = r.get(4)?;
                    Ok(Sub {
                        endpoint: r.get(0)?,
                        p256dh: r.get(1)?,
                        auth: r.get(2)?,
                        device_id: r.get(3)?,
                        group_ids: serde_json::from_str(&g).unwrap_or_default(),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        }).await
    }

    /// Latest known payload field in fold order (lamport desc, op_id desc) —
    /// matches the client fold exactly, never server arrival order.
    pub async fn latest_field(
        &self,
        group_id: &str,
        entity: &str,
        field: &str,
        entity_id: Option<&str>,
    ) -> Result<Option<String>> {
        self.with_reader(|conn| {
            let sql = match entity_id {
                Some(_) => "SELECT payload FROM operations WHERE group_id=?1 AND entity=?2 AND entity_id=?3 ORDER BY lamport DESC, op_id DESC",
                None => "SELECT payload FROM operations WHERE group_id=?1 AND entity=?2 ORDER BY lamport DESC, op_id DESC",
            };
            let mut stmt = conn.prepare(sql)?;
            let rows: Vec<String> = if let Some(eid) = entity_id {
                stmt.query_map(params![group_id, entity, eid], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<_>>()?
            } else {
                stmt.query_map(params![group_id, entity], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            for payload in rows {
                if let Some(v) = serde_json::from_str::<serde_json::Value>(&payload)
                    .ok()
                    .and_then(|p| p.get(field).cloned())
                {
                    if v != serde_json::Value::Null {
                        let s = match &v {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        if !s.is_empty() {
                            return Ok(Some(s));
                        }
                    }
                }
            }
            Ok(None)
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(op_id: &str, lamport: u64) -> OperationWire {
        OperationWire {
            op_id: op_id.into(),
            group_id: "g1".into(),
            entity: "expense".into(),
            entity_id: "e1".into(),
            action: "create".into(),
            payload: serde_json::json!({"amountCents": 100}),
            actor: "devA".into(),
            lamport,
            created_at: 1_700_000_000_000 + lamport,
        }
    }

    fn tmp_path(tag: &str) -> String {
        format!("/tmp/ardoise-dbtest-{}-{}.db", std::process::id(), tag)
    }

    #[tokio::test]
    async fn register_is_idempotent_and_resolve_case_insensitive() {
        let p = tmp_path("reg"); let _ = std::fs::remove_file(&p);
        let db = open(&p).unwrap();
        let g1 = db.register_group("g1").await.unwrap();
        let g2 = db.register_group("g1").await.unwrap();
        assert_eq!(g1.share_code, g2.share_code);
        assert!(db.resolve_code(&g1.share_code).await.unwrap().is_some());
        assert!(db.resolve_code(&g1.share_code.to_lowercase()).await.unwrap().is_some());
        assert!(db.resolve_code("ZZZZZZZZ").await.unwrap().is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[tokio::test]
    async fn push_is_idempotent_and_cursor_advances() {
        let p = tmp_path("push"); let _ = std::fs::remove_file(&p);
        let db = open(&p).unwrap();
        db.register_group("g1").await.unwrap();
        let (a1, c1) = db.push_ops("g1", &[op("o1", 1), op("o2", 2)]).await.unwrap();
        assert_eq!((a1.len(), c1), (2, 2));
        // duplicates: same call again + duplicate inside one batch
        let (a2, c2) = db.push_ops("g1", &[op("o1", 1), op("o2", 2)]).await.unwrap();
        assert_eq!((a2.len(), c2), (0, 2));
        let (a3, c3) = db.push_ops("g1", &[op("o2", 2), op("o3", 3), op("o3", 3)]).await.unwrap();
        assert_eq!(a3.len(), 1);
        assert_eq!(c3, 3);
        let _ = std::fs::remove_file(&p);
    }

    #[tokio::test]
    async fn pull_orders_by_seq_and_auto_heals_ahead_cursor() {
        let p = tmp_path("pull"); let _ = std::fs::remove_file(&p);
        let db = open(&p).unwrap();
        db.register_group("g1").await.unwrap();
        db.push_ops("g1", &[op("o1", 1), op("o2", 2), op("o3", 3)]).await.unwrap();
        let (rows, cursor) = db.pull_ops("g1", 0).await.unwrap();
        assert_eq!(cursor, 3);
        assert_eq!(rows.iter().map(|r| r.op_id.clone()).collect::<Vec<_>>(), vec!["o1", "o2", "o3"]);
        let (rows2, cursor2) = db.pull_ops("g1", 2).await.unwrap();
        assert_eq!((rows2.len(), cursor2), (1, 3));
        // Client cursor ahead of the server (DB restored from an older
        // backup): empty rows, REAL max cursor — the client resets.
        let (rows3, cursor3) = db.pull_ops("g1", 99).await.unwrap();
        assert_eq!((rows3.len(), cursor3), (0, 3));
        let _ = std::fs::remove_file(&p);
    }

    #[tokio::test]
    async fn sync_ops_is_push_then_pull_in_one_call() {
        let p = tmp_path("sync"); let _ = std::fs::remove_file(&p);
        let db = open(&p).unwrap();
        db.register_group("g1").await.unwrap();
        // Push one op and see it back in the same call.
        let (acc, rows, cursor) = db.sync_ops("g1", &[op("s1", 1)], 0).await.unwrap();
        assert_eq!((acc.len(), rows.iter().map(|r| r.op_id.as_str()).collect::<Vec<_>>(), cursor), (1, vec!["s1"], 1));
        // s1 duplicate + new s2: one accepted, window since=1 returns only s2.
        let (acc2, rows2, cursor2) = db.sync_ops("g1", &[op("s1", 1), op("s2", 2)], 1).await.unwrap();
        assert_eq!((acc2.iter().map(|r| r.op_id.as_str()).collect::<Vec<_>>(), rows2.iter().map(|r| r.op_id.as_str()).collect::<Vec<_>>(), cursor2), (vec!["s2"], vec!["s2"], 2));
        // Empty ops = pure pull.
        let (acc3, rows3, cursor3) = db.sync_ops("g1", &[], 2).await.unwrap();
        assert_eq!((acc3.len(), rows3.len(), cursor3), (0, 0, 2));
        let _ = std::fs::remove_file(&p);
    }
}
