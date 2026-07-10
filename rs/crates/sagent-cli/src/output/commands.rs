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
        print::line(&serde_json::to_string(&out)?)?;
        return Ok(());
    }
    if ok {
        print::line(&format!("ok {}ms", started.elapsed().as_millis()))?;
        return Ok(());
    }
    print::line("error")?;
    std::process::exit(1);
}
pub async fn health(
    client: &reqwest::Client,
    base_url: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let body = client.get(format!("{base_url}/health")).send().await?.error_for_status()?.text().await?;
    if json {
        print::line(&serde_json::to_string(&serde_json::json!({ "ok": body.trim() == "ok", "body": body }))?)?;
    } else {
        print::line(body.trim())?;
    }
    Ok(())
}

pub async fn config_openai(
    base_url: &str,
    api_key: &str,
    model: &str,
    timeout_ms: u64,
    allow_mock: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = sagent_llm::OpenAiPlannerConfig {
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        api_key: api_key.trim().to_string(),
        model: model.trim().to_string(),
        timeout_ms,
        allow_mock,
    };
    if config.base_url.is_empty() {
        return Err("base_url_required".into());
    }
    if config.api_key.is_empty() {
        return Err("api_key_required".into());
    }
    if config.model.is_empty() {
        return Err("model_required".into());
    }
    let path = sagent_llm::save_openai_config(&config)?;
    if json {
        print::line(&serde_json::to_string(&serde_json::json!({
            "ok": true,
            "path": path,
            "openai": {
                "base_url": config.base_url,
                "api_key": mask_secret(&config.api_key),
                "model": config.model,
                "timeout_ms": config.timeout_ms,
                "allow_mock": config.allow_mock
            }
        }))?)?;
    } else {
        print::line(&format!("saved {}", path.display()))?;
        print::line(&format!("openai chat {} model={} key={}", config.base_url, config.model, mask_secret(&config.api_key)))?;
    }
    Ok(())
}

pub async fn config_show(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let path = sagent_llm::config_path();
    let config = sagent_llm::load_openai_config();
    if json {
        let openai = config.map(|c| serde_json::json!({
            "base_url": c.base_url,
            "api_key": mask_secret(&c.api_key),
            "model": c.model,
            "timeout_ms": c.timeout_ms,
            "allow_mock": c.allow_mock
        }));
        print::line(&serde_json::to_string(&serde_json::json!({ "path": path, "openai": openai }))?)?;
    } else if let Some(c) = config {
        print::line(&format!("config {}", path.display()))?;
        print::line(&format!("openai chat {} model={} key={}", c.base_url, c.model, mask_secret(&c.api_key)))?;
    } else {
        print::line(&format!("config {}", path.display()))?;
        print::line("openai chat not configured")?;
    }
    Ok(())
}

fn mask_secret(secret: &str) -> String {
    let value = secret.trim();
    if value.len() <= 10 {
        return "***".to_string();
    }
    format!("{}…{}", &value[..6], &value[value.len() - 4..])
}

pub async fn validate(
    client: &reqwest::Client,
    base_url: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    validate_checks(client, base_url).await?;
    print_validate_ok(json)?;
    Ok(())
}

async fn validate_checks(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    require_health(client, base_url).await?;
    let run_id = create_validate_run(client, base_url).await?;
    require_terminal_events(client, base_url, &run_id).await?;
    require_terminal_status(client, base_url, &run_id).await?;
    require_no_events_after(client, base_url, &run_id).await?;
    Ok(())
}

async fn require_health(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let ok = client.get(format!("{base_url}/health")).send().await?.error_for_status().is_ok();
    if ok {
        Ok(())
    } else {
        Err("health_check_failed".into())
    }
}

async fn create_validate_run(
    client: &reqwest::Client,
    base_url: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let created = api::create_run(client, base_url, "validate_cli", None).await?;
    Ok(created.run_id)
}

async fn require_terminal_events(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let saw_terminal = api::stream_events(client, base_url, run_id, 1, |_| Ok(())).await?;
    if saw_terminal {
        Ok(())
    } else {
        Err("no_terminal_event".into())
    }
}

async fn require_terminal_status(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let run = api::get_run(client, base_url, run_id).await?;
    if run.status == "done" || run.status == "error" {
        Ok(())
    } else {
        Err("unexpected_status".into())
    }
}

async fn require_no_events_after(
    client: &reqwest::Client,
    base_url: &str,
    run_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ = api::stream_events(client, base_url, run_id, i64::MAX, |_| Err("unexpected_event".into())).await?;
    Ok(())
}

fn print_validate_ok(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        print::line(&serde_json::to_string(&serde_json::json!({ "ok": true }))?)?;
    } else {
        print::line("ok")?;
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
        print::line(&serde_json::to_string(&serde_json::json!({ "run_id": created.run_id, "status": created.status }))?)?;
    } else {
        print::line(&format!("run_id {}", created.run_id))?;
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
        print::line(&serde_json::to_string(&created)?)?;
    } else {
        print::line(&format!("{} {}", created.run_id, created.status))?;
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
        print::line(&serde_json::to_string(&res)?)?;
    } else {
        print::line(&format!("{} {}", res.run_id, res.status))?;
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
