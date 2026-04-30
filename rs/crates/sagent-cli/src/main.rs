use std::time::Instant;

use clap::{Parser, Subcommand};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Parser)]
#[command(name = "sagent-cli")]
struct Cli {
    #[arg(long, default_value = "http://127.0.0.1:3001")]
    url: String,

    #[arg(long)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Ping,
    Health,
    Run {
        task: String,
        #[arg(long)]
        max_steps: Option<u32>,
    },
    Runs {
        #[command(subcommand)]
        command: RunsCommand,
    },
}

#[derive(Subcommand)]
enum RunsCommand {
    Create {
        task: String,
        #[arg(long)]
        max_steps: Option<u32>,
    },
    Get {
        run_id: String,
    },
    Events {
        run_id: String,
        #[arg(long)]
        from_seq: Option<i64>,
    },
}

#[derive(Debug, Deserialize, Serialize)]
struct CreateRunResponse {
    run_id: String,
    status: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct GetRunResponse {
    run_id: String,
    status: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct SseEvent {
    run_id: String,
    seq: i64,
    ts_ms: i64,
    #[serde(rename = "type")]
    kind: String,
    payload: Value,
}

#[derive(Debug, Serialize)]
struct PingOutput {
    ok: bool,
    url: String,
    latency_ms: u128,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let base_url = cli.url.trim_end_matches('/').to_string();

    let client = reqwest::Client::builder().build()?;

    match cli.command {
        Command::Ping => {
            let started = Instant::now();
            let ok = client.get(format!("{base_url}/health")).send().await?.error_for_status().is_ok();
            let out = PingOutput { ok, url: base_url, latency_ms: started.elapsed().as_millis() };
            if cli.json {
                println!("{}", serde_json::to_string(&out)?);
            } else if ok {
                println!("ok {}ms", out.latency_ms);
            } else {
                println!("error");
                std::process::exit(1);
            }
        }
        Command::Health => {
            let text = client
                .get(format!("{base_url}/health"))
                .send()
                .await?
                .error_for_status()?
                .text()
                .await?;
            if cli.json {
                println!("{}", serde_json::to_string(&serde_json::json!({ "ok": text.trim() == "ok", "body": text }))?);
            } else {
                println!("{}", text.trim());
            }
        }
        Command::Run { task, max_steps } => {
            let created = create_run(&client, &base_url, &task, max_steps).await?;
            if cli.json {
                println!("{}", serde_json::to_string(&serde_json::json!({ "run_id": created.run_id, "status": created.status }))?);
            } else {
                println!("run_id {}", created.run_id);
            }
            stream_events(&client, &base_url, &created.run_id, Some(1), cli.json, true).await?;
        }
        Command::Runs { command } => match command {
            RunsCommand::Create { task, max_steps } => {
                let created = create_run(&client, &base_url, &task, max_steps).await?;
                if cli.json {
                    println!("{}", serde_json::to_string(&created)?);
                } else {
                    println!("{} {}", created.run_id, created.status);
                }
            }
            RunsCommand::Get { run_id } => {
                let res = client
                    .get(format!("{base_url}/api/runs/{run_id}"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<GetRunResponse>()
                    .await?;
                if cli.json {
                    println!("{}", serde_json::to_string(&res)?);
                } else {
                    println!("{} {}", res.run_id, res.status);
                }
            }
            RunsCommand::Events { run_id, from_seq } => {
                stream_events(&client, &base_url, &run_id, from_seq, cli.json, false).await?;
            }
        },
    }

    Ok(())
}

async fn create_run(
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

async fn stream_events(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
    from_seq: Option<i64>,
    json: bool,
    require_terminal: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    let url = format!(
        "{base_url}/api/runs/{run_id}/events?from_seq={}",
        from_seq.unwrap_or(1)
    );
    let mut resp = client.get(url).headers(headers).send().await?.error_for_status()?;

    let mut buf = Vec::<u8>::new();
    let mut terminal = false;
    while let Some(chunk) = resp.chunk().await? {
        buf.extend_from_slice(&chunk);
        while let Some(idx) = find_double_newline(&buf) {
            let frame = buf.drain(..idx + 2).collect::<Vec<u8>>();
            if let Some(ev) = parse_sse_frame(&frame)? {
                if json {
                    println!("{}", serde_json::to_string(&ev)?);
                } else {
                    print_text_event(&ev);
                }
                if ev.kind == "done" || ev.kind == "error" {
                    terminal = true;
                }
            }
        }
    }

    if !terminal {
        if require_terminal {
            return Err("no_terminal_event".into());
        }
    }

    Ok(())
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
            let ev = serde_json::from_str::<SseEvent>(data)?;
            return Ok(Some(ev));
        }
    }
    Ok(None)
}

fn print_text_event(ev: &SseEvent) {
    if ev.kind == "step" {
        println!("step {} {}", ev.seq, ev.payload);
        return;
    }
    if ev.kind == "llm_error" {
        println!("llm_error {} {}", ev.seq, ev.payload);
        return;
    }
    if ev.kind == "done" {
        if let Some(answer) = ev.payload.get("answer") {
            println!("done {} {}", ev.seq, answer);
        } else {
            println!("done {} {}", ev.seq, ev.payload);
        }
        return;
    }
    if ev.kind == "error" {
        println!("error {} {}", ev.seq, ev.payload);
        return;
    }
    println!("{} {} {}", ev.kind, ev.seq, ev.payload);
}
