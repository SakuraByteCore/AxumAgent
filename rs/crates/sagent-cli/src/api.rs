use reqwest::header::{HeaderMap, HeaderValue, ACCEPT};

use crate::types::{CreateRunResponse, GetRunResponse, SseEvent};

const SSE_ACCEPT: &str = "text/event-stream";

pub async fn create_run(
    client: &reqwest::Client,
    base_url: &str,
    task: &str,
    max_steps: Option<u32>,
) -> Result<CreateRunResponse, reqwest::Error> {
    client
        .post(format!("{base_url}/api/runs"))
        .json(&serde_json::json!({ "task": task, "max_steps": max_steps }))
        .send()
        .await?
        .error_for_status()?
        .json::<CreateRunResponse>()
        .await
}

pub async fn get_run(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
) -> Result<GetRunResponse, reqwest::Error> {
    client
        .get(format!("{base_url}/api/runs/{run_id}"))
        .send()
        .await?
        .error_for_status()?
        .json::<GetRunResponse>()
        .await
}

pub async fn stream_events(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
    from_seq: i64,
    mut on_event: impl FnMut(SseEvent) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static(SSE_ACCEPT));
    let url = format!("{base_url}/api/runs/{run_id}/events?from_seq={}", from_seq.max(1));
    let mut resp = client.get(url).headers(headers).send().await?.error_for_status()?;
    let mut buf = Vec::<u8>::new();
    let mut saw_terminal = false;
    while let Some(chunk) = resp.chunk().await? {
        buf.extend_from_slice(&chunk);
        saw_terminal |= drain_frames(&mut buf, &mut on_event)?;
    }
    Ok(saw_terminal)
}

fn drain_frames(
    buf: &mut Vec<u8>,
    on_event: &mut impl FnMut(SseEvent) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let mut saw_terminal = false;
    while let Some(idx) = find_double_newline(buf) {
        let frame = buf.drain(..idx + 2).collect::<Vec<u8>>();
        if let Some(ev) = parse_sse_frame(&frame)? {
            if ev.kind == "done" || ev.kind == "error" {
                saw_terminal = true;
            }
            on_event(ev)?;
        }
    }
    Ok(saw_terminal)
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn parse_sse_frame(frame: &[u8]) -> Result<Option<SseEvent>, Box<dyn std::error::Error>> {
    let s = std::str::from_utf8(frame)?;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            let data = rest.trim();
            if data.is_empty() {
                continue;
            }
            return Ok(Some(serde_json::from_str::<SseEvent>(data)?));
        }
    }
    Ok(None)
}

