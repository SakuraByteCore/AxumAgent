use std::sync::Arc;

use rusqlite::{params, Connection};
use serde_json::Value;

#[derive(Clone)]
pub struct Db {
    conn: Arc<std::sync::Mutex<Connection>>,
}

#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub run_id: String,
    pub seq: i64,
    pub ts_ms: i64,
    pub kind: String,
    pub payload: Value,
}

impl Db {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(Self { conn: Arc::new(std::sync::Mutex::new(conn)) })
    }

    pub fn migrate(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            create table if not exists runs (
              run_id text primary key,
              task text not null,
              status text not null,
              created_at_ms integer not null,
              updated_at_ms integer not null,
              next_seq integer not null default 1
            );

            create table if not exists run_events (
              id integer primary key autoincrement,
              run_id text not null,
              seq integer not null,
              ts_ms integer not null,
              kind text not null,
              payload_json text not null,
              unique(run_id, seq)
            );

            create index if not exists idx_run_events_run_id_seq on run_events(run_id, seq);
            "#,
        )?;
        Ok(())
    }

    pub fn insert_run(&self, run_id: &str, task: &str, status: &str, now_ms: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "insert into runs(run_id, task, status, created_at_ms, updated_at_ms, next_seq) values (?1, ?2, ?3, ?4, ?5, 1)",
            params![run_id, task, status, now_ms, now_ms],
        )?;
        Ok(())
    }

    pub fn update_run_status(&self, run_id: &str, status: &str, now_ms: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "update runs set status=?2, updated_at_ms=?3 where run_id=?1",
            params![run_id, status, now_ms],
        )?;
        Ok(())
    }

    pub fn get_run_status(&self, run_id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("select status from runs where run_id=?1")?;
        let mut rows = stmt.query(params![run_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get::<_, String>(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn get_run_next_seq(&self, run_id: &str) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("select next_seq from runs where run_id=?1")?;
        let mut rows = stmt.query(params![run_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get::<_, i64>(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn append_event(&self, run_id: &str, kind: &str, payload: &Value, now_ms: i64) -> rusqlite::Result<StoredEvent> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let seq: i64 = tx.query_row(
            "select next_seq from runs where run_id=?1",
            params![run_id],
            |row| row.get(0),
        )?;
        tx.execute("update runs set next_seq=next_seq+1, updated_at_ms=?2 where run_id=?1", params![run_id, now_ms])?;
        let payload_json = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string());
        tx.execute(
            "insert into run_events(run_id, seq, ts_ms, kind, payload_json) values (?1, ?2, ?3, ?4, ?5)",
            params![run_id, seq, now_ms, kind, payload_json],
        )?;
        tx.commit()?;
        Ok(StoredEvent {
            run_id: run_id.to_string(),
            seq,
            ts_ms: now_ms,
            kind: kind.to_string(),
            payload: payload.clone(),
        })
    }

    pub fn list_events_since(&self, run_id: &str, from_seq: i64, limit: i64) -> rusqlite::Result<Vec<StoredEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "select run_id, seq, ts_ms, kind, payload_json from run_events where run_id=?1 and seq>=?2 order by seq asc limit ?3",
        )?;
        let rows = stmt.query_map(params![run_id, from_seq, limit], |row| {
            let payload_json: String = row.get(4)?;
            let payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
            Ok(StoredEvent {
                run_id: row.get(0)?,
                seq: row.get(1)?,
                ts_ms: row.get(2)?,
                kind: row.get(3)?,
                payload,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}
