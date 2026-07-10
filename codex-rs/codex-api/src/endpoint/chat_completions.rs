use crate::auth::SharedAuthProvider;
use crate::common::ResponseEvent;
use crate::common::ResponseStream;
use crate::common::ResponsesApiRequest;
use crate::endpoint::session::EndpointSession;
use crate::error::ApiError;
use crate::provider::Provider;
use crate::rate_limits::parse_all_rate_limits;
use crate::requests::Compression;
use crate::requests::headers::build_session_headers;
use crate::requests::headers::insert_header;
use crate::requests::headers::subagent_header;
use codex_client::ByteStream;
use codex_client::EncodedJsonBody;
use codex_client::HttpTransport;
use codex_client::RequestCompression;
use codex_client::RequestTelemetry;
use codex_client::StreamResponse;
use codex_protocol::models::AgentMessageInputContent;
use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::ImageDetail;
use codex_protocol::models::ReasoningItemContent;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::TokenUsage;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use http::HeaderMap;
use http::HeaderValue;
use http::Method;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio::time::timeout;
use tracing::instrument;
use tracing::trace;

const OPENAI_MODEL_HEADER: &str = "openai-model";
const REQUEST_ID_HEADER: &str = "x-request-id";

pub struct ChatCompletionsClient<T: HttpTransport> {
    session: EndpointSession<T>,
}

#[derive(Default)]
pub struct ChatCompletionsOptions {
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub session_source: Option<SessionSource>,
    pub extra_headers: HeaderMap,
    pub compression: Compression,
}

impl<T: HttpTransport> ChatCompletionsClient<T> {
    pub fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self {
        Self {
            session: EndpointSession::new(transport, provider, auth),
        }
    }

    pub fn with_telemetry(self, request: Option<std::sync::Arc<dyn RequestTelemetry>>) -> Self {
        Self {
            session: self.session.with_request_telemetry(request),
        }
    }

    #[instrument(
        name = "chat_completions.stream_request",
        level = "info",
        skip_all,
        fields(
            transport = "chat_completions_http",
            http.method = "POST",
            api.path = "chat/completions"
        )
    )]
    pub async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        options: ChatCompletionsOptions,
    ) -> Result<ResponseStream, ApiError> {
        let body = build_chat_completions_body(&request)?;
        let body = EncodedJsonBody::encode(&body).map_err(|e| {
            ApiError::Stream(format!("failed to encode chat completions request: {e}"))
        })?;

        let ChatCompletionsOptions {
            session_id,
            thread_id,
            session_source,
            mut extra_headers,
            compression,
        } = options;

        if let Some(ref thread_id) = thread_id {
            insert_header(&mut extra_headers, "x-client-request-id", thread_id);
        }
        extra_headers.extend(build_session_headers(session_id, thread_id));
        if let Some(subagent) = subagent_header(&session_source) {
            insert_header(&mut extra_headers, "x-openai-subagent", &subagent);
        }

        self.stream_encoded(body, extra_headers, compression).await
    }

    fn path() -> &'static str {
        "chat/completions"
    }

    async fn stream_encoded(
        &self,
        body: EncodedJsonBody,
        extra_headers: HeaderMap,
        compression: Compression,
    ) -> Result<ResponseStream, ApiError> {
        let request_compression = match compression {
            Compression::None => RequestCompression::None,
            Compression::Zstd => RequestCompression::Zstd,
        };

        let stream_response = self
            .session
            .stream_encoded_json_with(
                Method::POST,
                Self::path(),
                extra_headers,
                Some(body),
                |req| {
                    req.headers.insert(
                        http::header::ACCEPT,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    req.compression = request_compression;
                },
            )
            .await?;

        Ok(spawn_chat_completions_stream(
            stream_response,
            self.session.provider().stream_idle_timeout,
        ))
    }
}

pub(crate) fn build_chat_completions_body(
    request: &ResponsesApiRequest,
) -> Result<Value, ApiError> {
    if request
        .text
        .as_ref()
        .and_then(|text| text.format.as_ref())
        .is_some()
    {
        return Err(ApiError::InvalidRequest {
            message: "output_schema is not supported by wire_api=\"chat\"".to_string(),
        });
    }

    let mut messages = Vec::new();
    if !request.instructions.is_empty() {
        messages.push(json!({
            "role": "system",
            "content": request.instructions,
        }));
    }

    for item in &request.input {
        match item {
            ResponseItem::Message { role, content, .. } => {
                messages.push(json!({
                    "role": role,
                    "content": chat_message_content(content),
                }));
            }
            ResponseItem::AgentMessage {
                author, content, ..
            } => {
                messages.push(json!({
                    "role": if author == "user" { "user" } else { "assistant" },
                    "content": agent_message_content(content),
                }));
            }
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } => {
                messages.push(json!({
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments,
                        }
                    }],
                }));
            }
            ResponseItem::FunctionCallOutput {
                call_id, output, ..
            } => {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": function_output_body_to_text(&output.body),
                }));
            }
            ResponseItem::Reasoning { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::Other => {}
            ResponseItem::AdditionalTools { .. }
            | ResponseItem::LocalShellCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::CustomToolCall { .. }
            | ResponseItem::CustomToolCallOutput { .. }
            | ResponseItem::ToolSearchOutput { .. } => {
                return Err(ApiError::InvalidRequest {
                    message: format!(
                        "{} is not supported by wire_api=\"chat\"",
                        response_item_type_name(item)
                    ),
                });
            }
        }
    }

    let mut body = Map::new();
    body.insert("model".to_string(), json!(request.model));
    body.insert("messages".to_string(), Value::Array(messages));
    body.insert("stream".to_string(), Value::Bool(true));
    body.insert(
        "stream_options".to_string(),
        json!({ "include_usage": true }),
    );

    let tools = convert_responses_tools_to_chat_tools(request.tools.as_deref())?;
    if !tools.is_empty() {
        body.insert("tools".to_string(), Value::Array(tools));
        body.insert("tool_choice".to_string(), json!(request.tool_choice));
        body.insert(
            "parallel_tool_calls".to_string(),
            json!(request.parallel_tool_calls),
        );
    }
    if let Some(service_tier) = &request.service_tier {
        body.insert("service_tier".to_string(), json!(service_tier));
    }

    Ok(Value::Object(body))
}

fn chat_message_content(content: &[ContentItem]) -> Value {
    let mut parts = Vec::new();
    let mut text_only = String::new();
    let mut has_non_text = false;

    for item in content {
        match item {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                text_only.push_str(text);
                if !text.is_empty() {
                    parts.push(json!({ "type": "text", "text": text }));
                }
            }
            ContentItem::InputImage { image_url, detail } => {
                has_non_text = true;
                let mut image_url_obj = Map::new();
                image_url_obj.insert("url".to_string(), json!(image_url));
                if let Some(detail) = detail.and_then(chat_image_detail) {
                    image_url_obj.insert("detail".to_string(), json!(detail));
                }
                parts.push(json!({
                    "type": "image_url",
                    "image_url": Value::Object(image_url_obj),
                }));
            }
        }
    }

    if has_non_text {
        Value::Array(parts)
    } else {
        Value::String(text_only)
    }
}

fn agent_message_content(content: &[AgentMessageInputContent]) -> String {
    content
        .iter()
        .filter_map(|item| match item {
            AgentMessageInputContent::InputText { text } => Some(text.as_str()),
            AgentMessageInputContent::EncryptedContent { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn chat_image_detail(detail: ImageDetail) -> Option<&'static str> {
    match detail {
        ImageDetail::Auto => Some("auto"),
        ImageDetail::Low => Some("low"),
        ImageDetail::High => Some("high"),
        ImageDetail::Original => None,
    }
}

fn function_output_body_to_text(body: &FunctionCallOutputBody) -> String {
    body.to_text().unwrap_or_default()
}

fn convert_responses_tools_to_chat_tools(tools: Option<&[Value]>) -> Result<Vec<Value>, ApiError> {
    let Some(tools) = tools else {
        return Ok(Vec::new());
    };

    let mut chat_tools = Vec::new();
    for tool in tools {
        match tool.get("type").and_then(Value::as_str) {
            Some("function") => chat_tools.push(responses_function_tool_to_chat_tool(tool)?),
            Some("namespace") => {
                let namespace = tool.get("name").and_then(Value::as_str).unwrap_or_default();
                let nested = tool.get("tools").and_then(Value::as_array).ok_or_else(|| {
                    ApiError::InvalidRequest {
                        message: "namespace tool is missing tools".to_string(),
                    }
                })?;
                for nested_tool in nested {
                    let mut flattened = nested_tool.clone();
                    if let Some(obj) = flattened.as_object_mut() {
                        if let Some(name) = obj.get("name").and_then(Value::as_str) {
                            obj.insert("name".to_string(), json!(format!("{namespace}{name}")));
                        }
                    }
                    chat_tools.push(responses_function_tool_to_chat_tool(&flattened)?);
                }
            }
            Some(other) => {
                return Err(ApiError::InvalidRequest {
                    message: format!("tool type {other:?} is not supported by wire_api=\"chat\""),
                });
            }
            None => {
                return Err(ApiError::InvalidRequest {
                    message: "tool is missing type".to_string(),
                });
            }
        }
    }

    Ok(chat_tools)
}

fn responses_function_tool_to_chat_tool(tool: &Value) -> Result<Value, ApiError> {
    let obj = tool.as_object().ok_or_else(|| ApiError::InvalidRequest {
        message: "function tool must be an object".to_string(),
    })?;

    let name = obj
        .get("name")
        .cloned()
        .ok_or_else(|| ApiError::InvalidRequest {
            message: "function tool is missing name".to_string(),
        })?;
    let description = obj
        .get("description")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    let parameters = obj
        .get("parameters")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));

    let mut function = Map::new();
    function.insert("name".to_string(), name);
    function.insert("description".to_string(), description);
    function.insert("parameters".to_string(), parameters);
    if let Some(strict) = obj.get("strict") {
        function.insert("strict".to_string(), strict.clone());
    }

    Ok(json!({
        "type": "function",
        "function": Value::Object(function),
    }))
}

fn response_item_type_name(item: &ResponseItem) -> &'static str {
    match item {
        ResponseItem::AdditionalTools { .. } => "additional_tools",
        ResponseItem::Message { .. } => "message",
        ResponseItem::AgentMessage { .. } => "agent_message",
        ResponseItem::Reasoning { .. } => "reasoning",
        ResponseItem::LocalShellCall { .. } => "local_shell_call",
        ResponseItem::FunctionCall { .. } => "function_call",
        ResponseItem::ToolSearchCall { .. } => "tool_search_call",
        ResponseItem::FunctionCallOutput { .. } => "function_call_output",
        ResponseItem::CustomToolCall { .. } => "custom_tool_call",
        ResponseItem::CustomToolCallOutput { .. } => "custom_tool_call_output",
        ResponseItem::ToolSearchOutput { .. } => "tool_search_output",
        ResponseItem::WebSearchCall { .. } => "web_search_call",
        ResponseItem::ImageGenerationCall { .. } => "image_generation_call",
        ResponseItem::Compaction { .. } => "compaction",
        ResponseItem::CompactionTrigger { .. } => "compaction_trigger",
        ResponseItem::ContextCompaction { .. } => "context_compaction",
        ResponseItem::Other => "other",
    }
}

fn spawn_chat_completions_stream(
    stream_response: StreamResponse,
    idle_timeout: std::time::Duration,
) -> ResponseStream {
    let rate_limit_snapshots = parse_all_rate_limits(&stream_response.headers);
    let server_model = stream_response
        .headers
        .get(OPENAI_MODEL_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(ToString::to_string);
    let upstream_request_id = stream_response
        .headers
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let (tx_event, rx_event) = mpsc::channel::<Result<ResponseEvent, ApiError>>(1600);

    tokio::spawn(async move {
        if let Some(model) = server_model {
            let _ = tx_event.send(Ok(ResponseEvent::ServerModel(model))).await;
        }
        for snapshot in rate_limit_snapshots {
            let _ = tx_event.send(Ok(ResponseEvent::RateLimits(snapshot))).await;
        }
        process_chat_completions_sse(stream_response.bytes, tx_event, idle_timeout).await;
    });

    ResponseStream {
        rx_event,
        upstream_request_id,
    }
}

async fn process_chat_completions_sse(
    stream: ByteStream,
    tx_event: mpsc::Sender<Result<ResponseEvent, ApiError>>,
    idle_timeout: std::time::Duration,
) {
    let mut stream = stream.eventsource();
    let mut assistant_text = String::new();
    let mut reasoning_text = String::new();
    let mut tool_calls: BTreeMap<u64, ToolCallState> = BTreeMap::new();
    let mut usage: Option<TokenUsage> = None;
    let mut completed = false;

    loop {
        let start = Instant::now();
        let response = timeout(idle_timeout, stream.next()).await;
        trace!(
            duration_ms = start.elapsed().as_millis(),
            "chat completions SSE poll"
        );

        let sse = match response {
            Ok(Some(Ok(ev))) => ev,
            Ok(Some(Err(e))) => {
                let _ = tx_event
                    .send(Err(ApiError::Stream(format!(
                        "chat completions SSE error: {e}"
                    ))))
                    .await;
                return;
            }
            Ok(None) => {
                break;
            }
            Err(_) => {
                let _ = tx_event
                    .send(Err(ApiError::Stream(
                        "idle timeout waiting for chat completions SSE".to_string(),
                    )))
                    .await;
                return;
            }
        };

        if sse.data.trim() == "[DONE]" {
            break;
        }

        let chunk: Value = match serde_json::from_str(&sse.data) {
            Ok(value) => value,
            Err(err) => {
                trace!(?err, data = %sse.data, "ignoring malformed chat completions SSE chunk");
                continue;
            }
        };
        trace!(?chunk, "chat completions SSE chunk");

        if let Some(chunk_usage) = chunk.get("usage") {
            usage = token_usage_from_chat_usage(chunk_usage).or(usage);
        }

        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            continue;
        };
        let delta = choice.get("delta");

        if let Some(content) = delta
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
            .filter(|content| !content.is_empty())
        {
            assistant_text.push_str(content);
            let _ = tx_event
                .send(Ok(ResponseEvent::OutputTextDelta(content.to_string())))
                .await;
        }

        if let Some(reasoning) = delta
            .and_then(reasoning_delta_text)
            .filter(|reasoning| !reasoning.is_empty())
        {
            reasoning_text.push_str(&reasoning);
            let _ = tx_event
                .send(Ok(ResponseEvent::ReasoningContentDelta {
                    delta: reasoning,
                    content_index: 0,
                }))
                .await;
        }

        if let Some(tool_delta) = delta
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(Value::as_array)
        {
            for call in tool_delta {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let state = tool_calls.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    state.id.get_or_insert_with(|| id.to_string());
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        state.name.get_or_insert_with(|| name.to_string());
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        state.arguments.push_str(arguments);
                        let _ = tx_event
                            .send(Ok(ResponseEvent::ToolCallInputDelta {
                                item_id: state.id.clone().unwrap_or_default(),
                                call_id: state.id.clone(),
                                delta: arguments.to_string(),
                            }))
                            .await;
                    }
                }
            }
        }

        if let Some(finish_reason) = choice.get("finish_reason").and_then(Value::as_str) {
            emit_terminal_items(
                &tx_event,
                &mut assistant_text,
                &mut reasoning_text,
                &mut tool_calls,
                Some(finish_reason),
            )
            .await;
            let _ = tx_event
                .send(Ok(ResponseEvent::Completed {
                    response_id: chunk
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    token_usage: usage.clone(),
                    end_turn: Some(finish_reason != "tool_calls"),
                }))
                .await;
            completed = true;
            break;
        }
    }

    if !completed {
        emit_terminal_items(
            &tx_event,
            &mut assistant_text,
            &mut reasoning_text,
            &mut tool_calls,
            None,
        )
        .await;
        let _ = tx_event
            .send(Ok(ResponseEvent::Completed {
                response_id: String::new(),
                token_usage: usage,
                end_turn: None,
            }))
            .await;
    }
}

async fn emit_terminal_items(
    tx_event: &mpsc::Sender<Result<ResponseEvent, ApiError>>,
    assistant_text: &mut String,
    reasoning_text: &mut String,
    tool_calls: &mut BTreeMap<u64, ToolCallState>,
    finish_reason: Option<&str>,
) {
    if !reasoning_text.is_empty() {
        let item = ResponseItem::Reasoning {
            id: None,
            summary: Vec::new(),
            content: Some(vec![ReasoningItemContent::ReasoningText {
                text: std::mem::take(reasoning_text),
            }]),
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
        };
        let _ = tx_event.send(Ok(ResponseEvent::OutputItemDone(item))).await;
    }

    if finish_reason == Some("tool_calls") || !tool_calls.is_empty() {
        for (_, state) in std::mem::take(tool_calls) {
            let call_id = state.id.unwrap_or_default();
            let item = ResponseItem::FunctionCall {
                id: None,
                name: state.name.unwrap_or_default(),
                namespace: None,
                arguments: state.arguments,
                call_id,
                internal_chat_message_metadata_passthrough: None,
            };
            let _ = tx_event.send(Ok(ResponseEvent::OutputItemDone(item))).await;
        }
        return;
    }

    if !assistant_text.is_empty() {
        let item = ResponseItem::Message {
            id: None,
            role: "assistant".to_string(),
            content: vec![ContentItem::OutputText {
                text: std::mem::take(assistant_text),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        };
        let _ = tx_event.send(Ok(ResponseEvent::OutputItemDone(item))).await;
    }
}

#[derive(Default)]
struct ToolCallState {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

fn reasoning_delta_text(delta: &Value) -> Option<String> {
    for key in ["reasoning", "reasoning_content"] {
        let Some(value) = delta.get(key) else {
            continue;
        };
        if let Some(text) = value.as_str() {
            return Some(text.to_string());
        }
        if let Some(text) = value
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| value.get("content").and_then(Value::as_str))
        {
            return Some(text.to_string());
        }
    }
    None
}

fn token_usage_from_chat_usage(usage: &Value) -> Option<TokenUsage> {
    let input_tokens = usage.get("prompt_tokens")?.as_i64()?;
    let output_tokens = usage.get("completion_tokens")?.as_i64()?;
    let total_tokens = usage.get("total_tokens")?.as_i64()?;
    let cached_input_tokens = usage
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let reasoning_output_tokens = usage
        .get("completion_tokens_details")
        .and_then(|details| details.get("reasoning_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    Some(TokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;
    use futures::StreamExt;
    use pretty_assertions::assert_eq;

    fn basic_request(input: Vec<ResponseItem>, tools: Option<Vec<Value>>) -> ResponsesApiRequest {
        ResponsesApiRequest {
            model: "gpt-4o".to_string(),
            instructions: "be terse".to_string(),
            input,
            tools,
            tool_choice: "auto".to_string(),
            parallel_tool_calls: true,
            reasoning: None,
            store: false,
            stream: true,
            stream_options: None,
            include: Vec::new(),
            service_tier: None,
            prompt_cache_key: None,
            text: None,
            client_metadata: None,
        }
    }

    #[test]
    fn builds_standard_chat_completions_payload_with_tools() {
        let request = basic_request(
            vec![
                ResponseItem::Message {
                    id: None,
                    role: "user".to_string(),
                    content: vec![ContentItem::InputText {
                        text: "hi".to_string(),
                    }],
                    phase: None,
                    internal_chat_message_metadata_passthrough: None,
                },
                ResponseItem::FunctionCall {
                    id: None,
                    name: "lookup".to_string(),
                    namespace: None,
                    arguments: "{\"q\":\"x\"}".to_string(),
                    call_id: "call_1".to_string(),
                    internal_chat_message_metadata_passthrough: None,
                },
                ResponseItem::FunctionCallOutput {
                    id: None,
                    call_id: "call_1".to_string(),
                    output: FunctionCallOutputPayload::from_text("ok".to_string()),
                    internal_chat_message_metadata_passthrough: None,
                },
            ],
            Some(vec![json!({
                "type": "function",
                "name": "lookup",
                "description": "Lookup something",
                "strict": false,
                "parameters": { "type": "object", "properties": {} }
            })]),
        );

        let body = build_chat_completions_body(&request).expect("chat body");
        assert_eq!(
            body,
            json!({
                "model": "gpt-4o",
                "messages": [
                    { "role": "system", "content": "be terse" },
                    { "role": "user", "content": "hi" },
                    {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "lookup",
                                "arguments": "{\"q\":\"x\"}"
                            }
                        }]
                    },
                    { "role": "tool", "tool_call_id": "call_1", "content": "ok" }
                ],
                "stream": true,
                "stream_options": { "include_usage": true },
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "lookup",
                        "description": "Lookup something",
                        "strict": false,
                        "parameters": { "type": "object", "properties": {} }
                    }
                }],
                "tool_choice": "auto",
                "parallel_tool_calls": true
            })
        );
    }

    #[test]
    fn rejects_output_schema_for_chat_completions() {
        let mut request = basic_request(Vec::new(), None);
        request.text = Some(crate::common::TextControls {
            verbosity: None,
            format: Some(crate::common::TextFormat {
                r#type: crate::common::TextFormatType::JsonSchema,
                strict: true,
                schema: json!({ "type": "object" }),
                name: "schema".to_string(),
            }),
        });

        let err = build_chat_completions_body(&request).expect_err("must reject schema");
        assert!(err.to_string().contains("output_schema"));
    }

    #[tokio::test]
    async fn parses_chat_sse_text_usage_and_completion() {
        let data = concat!(
            "data: {\"id\":\"chatcmpl_1\",\"choices\":[{\"delta\":{\"content\":\"he\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_1\",\"choices\":[{\"delta\":{\"content\":\"llo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}\n\n",
        );
        let stream: ByteStream = futures::stream::iter(vec![Ok(bytes::Bytes::from(data))]).boxed();
        let (tx, mut rx) = mpsc::channel(16);

        process_chat_completions_sse(stream, tx, std::time::Duration::from_secs(1)).await;

        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event.expect("event"));
        }

        assert!(matches!(events[0], ResponseEvent::OutputTextDelta(ref delta) if delta == "he"));
        assert!(matches!(events[1], ResponseEvent::OutputTextDelta(ref delta) if delta == "llo"));
        assert!(matches!(
            events[2],
            ResponseEvent::OutputItemDone(ResponseItem::Message { .. })
        ));
        assert!(
            matches!(events[3], ResponseEvent::Completed { ref response_id, token_usage: Some(TokenUsage { total_tokens: 5, .. }), end_turn: Some(true) } if response_id == "chatcmpl_1")
        );
    }

    #[tokio::test]
    async fn parses_chat_sse_tool_call() {
        let data = concat!(
            "data: {\"id\":\"chatcmpl_2\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\"\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl_2\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"x\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        );
        let stream: ByteStream = futures::stream::iter(vec![Ok(bytes::Bytes::from(data))]).boxed();
        let (tx, mut rx) = mpsc::channel(16);

        process_chat_completions_sse(stream, tx, std::time::Duration::from_secs(1)).await;

        let mut function_call = None;
        let mut completed = None;
        while let Some(event) = rx.recv().await {
            match event.expect("event") {
                ResponseEvent::OutputItemDone(ResponseItem::FunctionCall {
                    name,
                    arguments,
                    call_id,
                    ..
                }) => function_call = Some((name, arguments, call_id)),
                ResponseEvent::Completed { end_turn, .. } => completed = end_turn,
                _ => {}
            }
        }

        assert_eq!(
            function_call,
            Some((
                "lookup".to_string(),
                "{\"q\":\"x\"}".to_string(),
                "call_1".to_string()
            ))
        );
        assert_eq!(completed, Some(false));
    }
}
