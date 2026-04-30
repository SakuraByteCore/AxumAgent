use std::time::Instant;
use crate::api;
use crate::types::PingOutput;
use super::print;

pub async fn ping(
    client: &reqwest::Client,
    base_url: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let ok = client.get(format!("{base_url}/health")).send().await?.error_for_status().is_ok();
    if json {
        let out = PingOutput { ok, url: base_url.to_string(), latency_ms: started.elapsed().as_millis() };
        println!("{}", serde_json::to_string(&out)?);
        return Ok(());
    }
    if ok {
        println!("ok {}ms", started.elapsed().as_millis());
        return Ok(());
    }
    println!("error");
    std::process::exit(1);
}
pub async fn health(
    client: &reqwest::Client,
    base_url: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let body = client.get(format!("{base_url}/health")).send().await?.error_for_status()?.text().await?;
    if json {
        println!("{}", serde_json::to_string(&serde_json::json!({ "ok": body.trim() == "ok", "body": body }))?);
    } else {
        println!("{}", body.trim());
    }
    Ok(())
}
pub async fn run(
    client: &reqwest::Client,
    base_url: &str,
    task: &str,
    max_steps: Option<u32>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let created = api::create_run(client, base_url, task, max_steps).await?;
    if json {
        println!("{}", serde_json::to_string(&serde_json::json!({ "run_id": created.run_id, "status": created.status }))?);
    } else {
        println!("run_id {}", created.run_id);
    }
    let saw_terminal = api::stream_events(client, base_url, &created.run_id, 1, |ev| print::event(&ev, json)).await?;
    if saw_terminal {
        Ok(())
    } else {
        Err("no_terminal_event".into())
    }
}
pub async fn runs_create(
    client: &reqwest::Client,
    base_url: &str,
    task: &str,
    max_steps: Option<u32>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let created = api::create_run(client, base_url, task, max_steps).await?;
    if json {
        println!("{}", serde_json::to_string(&created)?);
    } else {
        println!("{} {}", created.run_id, created.status);
    }
    Ok(())
}
pub async fn runs_get(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let res = api::get_run(client, base_url, run_id).await?;
    if json {
        println!("{}", serde_json::to_string(&res)?);
    } else {
        println!("{} {}", res.run_id, res.status);
    }
    Ok(())
}
pub async fn runs_events(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
    from_seq: Option<i64>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ = api::stream_events(client, base_url, run_id, from_seq.unwrap_or(1), |ev| print::event(&ev, json)).await?;
    Ok(())
}
