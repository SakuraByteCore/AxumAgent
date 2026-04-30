use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use sagent_types::{Action, AgentError, Decision, NotifyLevel, ToolAction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct PlannerContext<'a> {
    pub task: &'a str,
    pub step: u32,
    pub history_json: Value,
    pub observation_json: Value,
    pub tools_schema_json: Value,
}

#[async_trait]
pub trait Planner: Send + Sync {
    async fn plan(&self, ctx: PlannerContext<'_>) -> Result<Decision, AgentError>;
}

#[derive(Debug, Clone)]
pub struct OpenAiCompatiblePlanner {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
    allow_mock: bool,
}

impl OpenAiCompatiblePlanner {
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("OPENAI_BASE_URL").ok()?;
        let api_key = std::env::var("OPENAI_API_KEY").ok()?;
        let model = std::env::var("OPENAI_MODEL").ok()?;
        let timeout_ms = std::env::var("OPENAI_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60_000);
        let allow_mock = std::env::var("OPENAI_ALLOW_MOCK")
            .ok()
            .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "yes"));
        Some(Self::new(base_url, api_key, model, Duration::from_millis(timeout_ms), allow_mock))
    }

    pub fn new(base_url: String, api_key: String, model: String, timeout: Duration, allow_mock: bool) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client, base_url, api_key, model, allow_mock }
    }
}

#[derive(Debug, Error)]
enum PlanError {
    #[error("http_error")]
    Http,
    #[error("invalid_response")]
    InvalidResponse,
    #[error("missing_content")]
    MissingContent,
    #[error("json_parse_failed")]
    JsonParseFailed,
    #[error("invalid_action")]
    InvalidAction,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    temperature: f32,
}

#[derive(Debug, Serialize)]
struct Message<'a> {
    role: &'a str,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Usage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct LlmDecision {
    rationale: Option<String>,
    action: Value,
}

fn build_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{}/chat/completions", trimmed)
    } else {
        format!("{}/v1/chat/completions", trimmed)
    }
}

fn extract_first_json_object(input: &str) -> Option<&str> {
    let start = input.find('{')?;
    let end = input.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&input[start..=end])
}

fn parse_llm_decision(content: &str) -> Result<LlmDecision, PlanError> {
    if let Ok(v) = serde_json::from_str::<LlmDecision>(content) {
        return Ok(v);
    }
    if let Some(obj) = extract_first_json_object(content) {
        serde_json::from_str::<LlmDecision>(obj).map_err(|_| PlanError::JsonParseFailed)
    } else {
        Err(PlanError::JsonParseFailed)
    }
}

fn build_system_prompt() -> String {
    [
        "你是一个任务规划器。你必须输出一个 JSON 对象，不要输出 Markdown 或解释文字。",
        "输出格式：{ \"rationale\": \"...\", \"action\": ... }",
        "action 只能是两类之一：",
        "1) 完成：{ \"type\": \"finish\", \"answer\": \"...\" }",
        "2) 调用工具：{ \"type\": \"tool\", \"tool\": \"<tool_id>\", \"name\": \"<action_name>\", \"input\": { ... } }",
        "如果你需要用户补充信息，请输出 finish，answer 中提出具体问题。",
    ]
    .join("\n")
}

fn parse_action(action: &Value) -> Result<Action, PlanError> {
    let ty = action.get("type").and_then(|v| v.as_str()).ok_or(PlanError::InvalidAction)?;
    match ty {
        "finish" => {
            let answer = action.get("answer").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(Action::Finish { answer })
        }
        "tool" => {
            let tool = action.get("tool").and_then(|v| v.as_str()).ok_or(PlanError::InvalidAction)?.to_string();
            let name = action.get("name").and_then(|v| v.as_str()).ok_or(PlanError::InvalidAction)?.to_string();
            let input = action.get("input").cloned();
            Ok(Action::Tool(ToolAction { tool, name, input }))
        }
        "notify_user" => {
            let message = action.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let level = match action.get("level").and_then(|v| v.as_str()).unwrap_or("info") {
                "warning" => NotifyLevel::Warning,
                "error" => NotifyLevel::Error,
                _ => NotifyLevel::Info,
            };
            Ok(Action::NotifyUser { message, level })
        }
        _ => Err(PlanError::InvalidAction),
    }
}

#[async_trait]
impl Planner for OpenAiCompatiblePlanner {
    async fn plan(&self, ctx: PlannerContext<'_>) -> Result<Decision, AgentError> {
        if self.allow_mock && let Ok(mock) = std::env::var("OPENAI_MOCK_RESPONSE") {
            let llm: LlmDecision = serde_json::from_str(&mock)
                .map_err(|_| AgentError::Other(PlanError::JsonParseFailed.to_string()))?;
            let rationale = llm.rationale.unwrap_or_default();
            let action = parse_action(&llm.action).map_err(|_| AgentError::Other(PlanError::InvalidAction.to_string()))?;
            return Ok(Decision { rationale, action, model: Some(self.model.clone()), usage: None });
        }

        let url = build_chat_completions_url(&self.base_url);

        let user_payload = serde_json::json!({
            "task": ctx.task,
            "step": ctx.step,
            "history": ctx.history_json,
            "observation": ctx.observation_json,
            "tools": ctx.tools_schema_json,
        });

        let req = ChatCompletionRequest {
            model: &self.model,
            messages: vec![
                Message { role: "system", content: build_system_prompt() },
                Message { role: "user", content: user_payload.to_string() },
            ],
            temperature: 0.1,
        };

        let mut headers = HeaderMap::new();
        let token = format!("Bearer {}", self.api_key);
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&token).map_err(|_| AgentError::Other(PlanError::Http.to_string()))?);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let resp = self
            .client
            .post(url)
            .headers(headers)
            .json(&req)
            .send()
            .await
            .map_err(|_| AgentError::Other(PlanError::Http.to_string()))?;

        if !resp.status().is_success() {
            return Err(AgentError::Other(PlanError::Http.to_string()));
        }

        let parsed: ChatCompletionResponse = resp.json().await.map_err(|_| AgentError::Other(PlanError::InvalidResponse.to_string()))?;
        let content = parsed
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or_else(|| AgentError::Other(PlanError::MissingContent.to_string()))?;

        let llm = parse_llm_decision(&content).map_err(|e| AgentError::Other(e.to_string()))?;
        let rationale = llm.rationale.unwrap_or_default();
        let action = parse_action(&llm.action).map_err(|_| AgentError::Other(PlanError::InvalidAction.to_string()))?;

        Ok(Decision {
            rationale,
            action,
            model: Some(self.model.clone()),
            usage: parsed.usage.map(|u| sagent_types::TokenUsage {
                prompt_tokens: u.prompt_tokens.unwrap_or(0),
                completion_tokens: u.completion_tokens.unwrap_or(0),
            }),
        })
    }
}
