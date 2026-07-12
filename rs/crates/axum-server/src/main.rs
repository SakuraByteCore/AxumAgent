use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::{routing::get, routing::post, Json, Router};
use async_trait::async_trait;
use futures::Stream;
use serde::{Deserialize, Serialize};
use axum_llm::{OpenAiCompatiblePlanner, Planner, PlannerContext};
use axum_policy::{AllowAllPolicy, Policy};
use axum_runtime::{RuntimeEvent, RuntimeHooks};
use axum_tools::{EchoTool, FsTool, ToolRegistry};
use axum_types::{
    Action, AgentError, Authorization, Decision, HistoryStep, NotifyLevel, Observation, ToolAction,
};
use tracing_subscriber::EnvFilter;

mod db;
mod manager;

use db::Db;
use manager::{now_ms, RunManager, RunRequest as ManagerRunRequest};

#[derive(Clone)]
struct DemoState {
    tools: std::sync::Arc<ToolRegistry>,
    policy: std::sync::Arc<dyn Policy>,
}

#[derive(Clone)]
struct AppState {
    manager: RunManager,
}

struct RunHooks {
    manager: RunManager,
    run_id: String,
    step_tx: tokio::sync::mpsc::UnboundedSender<serde_json::Value>,
    planner: Option<std::sync::Arc<dyn Planner>>,
}

#[async_trait]
impl RuntimeHooks for RunHooks {
    type State = DemoState;

    async fn initialize(&self, _task: &str) -> Result<Self::State, AgentError> {
        let mut registry = ToolRegistry::new();
        registry.register(EchoTool::default());
        registry.register(FsTool { sandbox_root: std::env::current_dir().unwrap_or_else(|_| ".".into()).to_string_lossy().to_string() });

        Ok(DemoState {
            tools: std::sync::Arc::new(registry),
            policy: std::sync::Arc::new(AllowAllPolicy::default()),
        })
    }

    async fn observe(
        &self,
        _state: &Self::State,
        _task: &str,
        _step: u32,
        _history: &[HistoryStep],
    ) -> Result<Observation, AgentError> {
        Ok(Observation { summary: Some("demo_observation".to_string()), url: None, title: None, data: None })
    }

    async fn decide(
        &self,
        _state: &Self::State,
        task: &str,
        step: u32,
        history: &[HistoryStep],
        observation: &Observation,
    ) -> Result<Decision, AgentError> {
        if let Some(planner) = &self.planner {
            let tools_schema_json = serde_json::json!({
                "tools": [
                    { "tool": "echo", "name": "echo", "input_schema": { "type": "object", "properties": { "task": { "type": "string" } }, "required": ["task"] } },
                    { "tool": "fs", "name": "read_file", "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } }
                ]
            });
            let ctx = PlannerContext {
                task,
                step,
                history_json: serde_json::to_value(history).unwrap_or(serde_json::Value::Null),
                observation_json: serde_json::to_value(observation).unwrap_or(serde_json::Value::Null),
                tools_schema_json,
            };

            match planner.plan(ctx).await {
                Ok(d) => return Ok(d),
                Err(e) => {
                    let _ = self
                        .manager
                        .emit(&self.run_id, "llm_error", serde_json::json!({ "error": e.to_string() }))
                        .await;
                }
            }
        }

        if history.is_empty() {
            Ok(Decision {
                rationale: "echo task".to_string(),
                action: Action::Tool(ToolAction {
                    tool: "echo".to_string(),
                    name: "echo".to_string(),
                    input: Some(serde_json::json!({ "task": task })),
                }),
                model: None,
                usage: None,
            })
        } else {
            Ok(Decision {
                rationale: "finish".to_string(),
                action: Action::Finish { answer: history.last().map(|h| h.result.clone()).unwrap_or_default() },
                model: None,
                usage: None,
            })
        }
    }

    async fn authorize(
        &self,
        state: &Self::State,
        _task: &str,
        _step: u32,
        _history: &[HistoryStep],
        _observation: &Observation,
        decision: &Decision,
    ) -> Result<Authorization, AgentError> {
        Ok(state.policy.authorize(&decision.action).await)
    }

    async fn execute(
        &self,
        state: &Self::State,
        _task: &str,
        _step: u32,
        _history: &[HistoryStep],
        _observation: &Observation,
        decision: &Decision,
    ) -> Result<String, AgentError> {
        match &decision.action {
            Action::Tool(action) => state.tools.execute(action).await,
            Action::AskUser { question } => Ok(question.clone()),
            Action::NotifyUser { message, level } => Ok(format!("{}:{message}", match level {
                NotifyLevel::Info => "info",
                NotifyLevel::Warning => "warning",
                NotifyLevel::Error => "error",
            })),
            Action::Finish { answer } => Ok(answer.clone()),
        }
    }

    fn should_observe(&self, _last_action: Option<&Action>) -> bool {
        true
    }

    fn on_step_event(&self, event: RuntimeEvent<'_>) {
        let payload = match event {
            RuntimeEvent::Observe { step, observation } => serde_json::json!({
                "step": step,
                "stage": "observe",
                "observation": observation
            }),
            RuntimeEvent::Action { step, decision } => serde_json::json!({
                "step": step,
                "stage": "action",
                "decision": decision
            }),
            RuntimeEvent::Result { step, result } => serde_json::json!({
                "step": step,
                "stage": "result",
                "result": result
            }),
        };
        let _ = self.step_tx.send(payload);
    }
}

#[derive(Debug, Deserialize)]
struct CreateRunRequest {
    task: String,
    #[serde(default)]
    max_steps: Option<u32>,
}

#[derive(Debug, Serialize)]
struct CreateRunResponse {
    run_id: String,
    status: String,
}

async fn health() -> &'static str {
    "ok"
}

async fn create_run(
    State(state): State<AppState>,
    Json(req): Json<CreateRunRequest>,
) -> Result<Json<CreateRunResponse>, (axum::http::StatusCode, String)> {
    let max_steps = req.max_steps.unwrap_or(8);
    let queued = state
        .manager
        .enqueue(req.task, max_steps)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(CreateRunResponse { run_id: queued.run_id, status: "queued".to_string() }))
}

#[derive(Debug, Serialize)]
struct GetRunResponse {
    run_id: String,
    status: String,
}

async fn get_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<Json<GetRunResponse>, (axum::http::StatusCode, String)> {
    let status = state
        .manager
        .get_status(&run_id)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (axum::http::StatusCode::NOT_FOUND, "not_found".to_string()))?;
    Ok(Json(GetRunResponse { run_id, status }))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    #[serde(default)]
    from_seq: Option<i64>,
}

async fn run_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(q): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (axum::http::StatusCode, String)> {
    let from_seq = q.from_seq.unwrap_or(1).max(1);
    let status = state
        .manager
        .get_status(&run_id)
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if status.is_none() {
        return Err((axum::http::StatusCode::NOT_FOUND, "not_found".to_string()));
    }
    let close_immediately = match status.as_deref() {
        Some("done") | Some("error") => state
            .manager
            .get_next_seq(&run_id)
            .await
            .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))?
            .is_some_and(|next_seq| from_seq >= next_seq),
        _ => false,
    };

    let mut rx = state.manager.subscribe();
    let manager = state.manager.clone();
    let run_id_s = run_id.clone();

    let stream = async_stream::stream! {
        if close_immediately {
            return;
        }
        let mut cursor = from_seq;
        let mut terminal = false;
        loop {
            let batch = manager.list_events_since(&run_id_s, cursor, 10_000).await.unwrap_or_default();
            if batch.is_empty() {
                break;
            }
            for ev in batch {
                cursor = (ev.seq + 1).max(cursor);
                if ev.kind == "done" || ev.kind == "error" {
                    terminal = true;
                }
                let data = serde_json::json!({
                    "run_id": ev.run_id,
                    "seq": ev.seq,
                    "ts_ms": ev.ts_ms,
                    "type": ev.kind,
                    "payload": ev.payload
                });
                let s = serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string());
                yield Ok(Event::default().event("event").data(s));
            }
        }

        if terminal {
            return;
        }

        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if ev.run_id != run_id_s || ev.seq < cursor {
                        continue;
                    }
                    cursor = ev.seq + 1;
                    let is_terminal = ev.kind == "done" || ev.kind == "error";
                    let data = serde_json::json!({
                        "run_id": ev.run_id,
                        "seq": ev.seq,
                        "ts_ms": ev.ts_ms,
                        "type": ev.kind,
                        "payload": ev.payload
                    });
                    let s = serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string());
                    yield Ok(Event::default().event("event").data(s));
                    if is_terminal {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    loop {
                        let batch = manager.list_events_since(&run_id_s, cursor, 10_000).await.unwrap_or_default();
                        if batch.is_empty() {
                            break;
                        }
                        for ev in batch {
                            cursor = (ev.seq + 1).max(cursor);
                            let is_terminal = ev.kind == "done" || ev.kind == "error";
                            let data = serde_json::json!({
                                "run_id": ev.run_id,
                                "seq": ev.seq,
                                "ts_ms": ev.ts_ms,
                                "type": ev.kind,
                                "payload": ev.payload
                            });
                            let s = serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string());
                            yield Ok(Event::default().event("event").data(s));
                            if is_terminal {
                                return;
                            }
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive")))
}

async fn worker_loop(manager: RunManager, mut rx: tokio::sync::mpsc::Receiver<ManagerRunRequest>) {
    while let Some(req) = rx.recv().await {
        let _ = manager.set_status(&req.run_id, "running").await;
        let _ = manager.emit(&req.run_id, "status", serde_json::json!({"status":"running"})).await;

        let (step_tx, mut step_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
        let run_id_for_steps = req.run_id.clone();
        let manager_for_steps = manager.clone();
        let planner = OpenAiCompatiblePlanner::from_env().map(|p| std::sync::Arc::new(p) as std::sync::Arc<dyn Planner>);
        let steps_forwarder = tokio::spawn(async move {
            while let Some(payload) = step_rx.recv().await {
                let _ = manager_for_steps.emit(&run_id_for_steps, "step", payload).await;
            }
        });

        let hooks = RunHooks { manager: manager.clone(), run_id: req.run_id.clone(), step_tx, planner };
        let task = req.task.clone();
        let max_steps = req.max_steps;

        let started_ms = now_ms();
        let result = axum_runtime::run_agent(&hooks, &task, max_steps, || false).await;
        drop(hooks);
        let _ = steps_forwarder.await;

        match result {
            Ok(r) => {
                let _ = manager.emit(&req.run_id, "done", serde_json::json!({
                    "answer": r.answer,
                    "steps": r.steps,
                    "elapsed_ms": now_ms() - started_ms
                })).await;
                let _ = manager.set_status(&req.run_id, "done").await;
            }
            Err(e) => {
                let _ = manager.emit(&req.run_id, "error", serde_json::json!({
                    "error": e.to_string(),
                    "elapsed_ms": now_ms() - started_ms
                })).await;
                let _ = manager.set_status(&req.run_id, "error").await;
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let db_path = std::env::var("AXUM_DB_PATH").unwrap_or_else(|_| "data/axum.db".to_string());
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let db = Db::open(&db_path)?;
    db.migrate()?;

    let (manager, rx) = RunManager::new(db, 1024);
    let state = AppState { manager: manager.clone() };
    tokio::spawn(worker_loop(manager, rx));

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/runs", post(create_run))
        .route("/api/runs/{run_id}", get(get_run))
        .route("/api/runs/{run_id}/events", get(run_events))
        .with_state(state);

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3001);
    let addr: std::net::SocketAddr = format!("{host}:{port}").parse()?;
    tracing::info!("listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
