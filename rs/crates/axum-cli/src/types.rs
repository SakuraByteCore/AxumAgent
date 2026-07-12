use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize)]
pub struct CreateRunResponse {
    pub run_id: String,
    pub status: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct GetRunResponse {
    pub run_id: String,
    pub status: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SseEvent {
    pub run_id: String,
    pub seq: i64,
    pub ts_ms: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct PingOutput {
    pub ok: bool,
    pub url: String,
    pub latency_ms: u128,
}

