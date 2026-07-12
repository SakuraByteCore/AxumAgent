use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::db::{Db, StoredEvent};

#[derive(Debug, Clone)]
pub struct RunRequest {
    pub run_id: String,
    pub task: String,
    pub max_steps: u32,
}

#[derive(Clone)]
pub struct RunManager {
    db: Db,
    tx: mpsc::Sender<RunRequest>,
    events_tx: broadcast::Sender<StoredEvent>,
}

impl RunManager {
    pub fn new(db: Db, queue_capacity: usize) -> (Self, mpsc::Receiver<RunRequest>) {
        let (tx, rx) = mpsc::channel(queue_capacity);
        let (events_tx, _events_rx) = broadcast::channel(1024);
        (Self { db, tx, events_tx }, rx)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StoredEvent> {
        self.events_tx.subscribe()
    }

    pub async fn enqueue(&self, task: String, max_steps: u32) -> Result<RunRequest, String> {
        let run_id = Uuid::new_v4().to_string();
        let now_ms = now_ms();
        let db = self.db.clone();
        let run_id_for_db = run_id.clone();
        let task_for_db = task.clone();
        tokio::task::spawn_blocking(move || {
            db.insert_run(&run_id_for_db, &task_for_db, "queued", now_ms)
        })
        .await
        .map_err(|_| "db_join_error".to_string())?
        .map_err(|e| format!("db_error:{e}"))?;

        let req = RunRequest {
            run_id,
            task,
            max_steps,
        };
        self.tx
            .send(req.clone())
            .await
            .map_err(|_| "queue_closed".to_string())?;
        Ok(req)
    }

    pub async fn emit(
        &self,
        run_id: &str,
        kind: &str,
        payload: Value,
    ) -> Result<StoredEvent, String> {
        let db = self.db.clone();
        let run_id_s = run_id.to_string();
        let kind_s = kind.to_string();
        let now_ms = now_ms();
        let stored = tokio::task::spawn_blocking(move || {
            db.append_event(&run_id_s, &kind_s, &payload, now_ms)
        })
        .await
        .map_err(|_| "db_join_error".to_string())?
        .map_err(|e| format!("db_error:{e}"))?;
        let _ = self.events_tx.send(stored.clone());
        Ok(stored)
    }

    pub async fn set_status(&self, run_id: &str, status: &str) -> Result<(), String> {
        let db = self.db.clone();
        let run_id_s = run_id.to_string();
        let status_s = status.to_string();
        let now_ms = now_ms();
        tokio::task::spawn_blocking(move || db.update_run_status(&run_id_s, &status_s, now_ms))
            .await
            .map_err(|_| "db_join_error".to_string())?
            .map_err(|e| format!("db_error:{e}"))?;
        Ok(())
    }

    pub async fn get_status(&self, run_id: &str) -> Result<Option<String>, String> {
        let db = self.db.clone();
        let run_id_s = run_id.to_string();
        let res = tokio::task::spawn_blocking(move || db.get_run_status(&run_id_s))
            .await
            .map_err(|_| "db_join_error".to_string())?
            .map_err(|e| format!("db_error:{e}"))?;
        Ok(res)
    }

    pub async fn get_next_seq(&self, run_id: &str) -> Result<Option<i64>, String> {
        let db = self.db.clone();
        let run_id_s = run_id.to_string();
        let res = tokio::task::spawn_blocking(move || db.get_run_next_seq(&run_id_s))
            .await
            .map_err(|_| "db_join_error".to_string())?
            .map_err(|e| format!("db_error:{e}"))?;
        Ok(res)
    }

    pub async fn list_events_since(
        &self,
        run_id: &str,
        from_seq: i64,
        limit: i64,
    ) -> Result<Vec<StoredEvent>, String> {
        let db = self.db.clone();
        let run_id_s = run_id.to_string();
        let events =
            tokio::task::spawn_blocking(move || db.list_events_since(&run_id_s, from_seq, limit))
                .await
                .map_err(|_| "db_join_error".to_string())?
                .map_err(|e| format!("db_error:{e}"))?;
        Ok(events)
    }
}

pub fn now_ms() -> i64 {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    (dur.as_secs() as i64) * 1000 + (dur.subsec_millis() as i64)
}
