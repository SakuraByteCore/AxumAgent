use anyhow::{Context, Result, anyhow};
use clap::{Args, Parser, Subcommand, ValueEnum};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::time::sleep;

const DEFAULT_PROVIDER: &str = "openai-chat";
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4o-mini";
const DEFAULT_API_KEY_ENV: &str = "OPENAI_API_KEY";
const DEFAULT_MAX_RETRIES: u32 = 8;
const DEFAULT_RETRY_MIN_DELAY_MS: u64 = 500;
const DEFAULT_RETRY_MAX_DELAY_MS: u64 = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 600_000;

#[derive(Debug, Parser)]
#[command(name = "axum", version, about = "AxumAgent Rust CLI")]
struct Cli {
    #[arg(long, global = true, env = "AXUM_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long, global = true)]
    provider: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Init(InitArgs),
    Chat(ChatArgs),
    Tui(TuiArgs),
    Doctor(DiagnosticArgs),
    Providers(DiagnosticArgs),
    Modes,
    Workflow(WorkflowArgs),
    Parallel(ParallelArgs),
    ConfigWeb(ConfigWebArgs),
    Run(RunArgs),
}

#[derive(Debug, Args)]
struct InitArgs {
    #[arg(long)]
    provider_config: Option<String>,
    #[arg(long, env = "AXUM_OPENAI_BASE_URL", default_value = DEFAULT_BASE_URL)]
    base_url: String,
    #[arg(long)]
    api_key: Option<String>,
    #[arg(short, long, env = "AXUM_MODEL", default_value = DEFAULT_MODEL)]
    model: String,
    #[arg(long)]
    force: bool,
}

#[derive(Debug, Args, Clone)]
struct ChatArgs {
    #[arg(short, long, env = "AXUM_MODEL")]
    model: Option<String>,
    #[arg(long)]
    system: Option<String>,
    #[arg(long)]
    temperature: Option<f32>,
    #[arg(long, env = "AXUM_OPENAI_MAX_RETRIES")]
    max_retries: Option<u32>,
    #[arg(long, env = "AXUM_OPENAI_RETRY_MIN_DELAY_MS")]
    retry_min_delay_ms: Option<u64>,
    #[arg(long, env = "AXUM_OPENAI_RETRY_MAX_DELAY_MS")]
    retry_max_delay_ms: Option<u64>,
    #[arg(long, env = "AXUM_OPENAI_REQUEST_TIMEOUT_MS")]
    request_timeout_ms: Option<u64>,
    #[arg(long)]
    json: bool,
    #[arg(value_name = "PROMPT", trailing_var_arg = true)]
    prompt: Vec<String>,
}

#[derive(Debug, Args)]
struct TuiArgs {
    #[command(flatten)]
    chat: ChatArgs,
    #[arg(long)]
    dry_run: bool,
    #[arg(long)]
    no_alt_screen: bool,
    #[arg(long, value_enum, default_value_t = AgentMode::Code)]
    mode: AgentMode,
}

#[derive(Debug, Args, Clone)]
struct DiagnosticArgs {
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct WorkflowArgs {
    #[arg(long, value_enum, default_value_t = AgentMode::Code)]
    mode: AgentMode,
    #[arg(long)]
    verbose: bool,
    #[arg(value_name = "PROMPT", trailing_var_arg = true)]
    prompt: Vec<String>,
}

#[derive(Debug, Args)]
struct ParallelArgs {
    #[arg(long = "task")]
    tasks: Vec<String>,
    #[arg(value_name = "GOAL", trailing_var_arg = true)]
    goal: Vec<String>,
}

#[derive(Debug, Args)]
struct ConfigWebArgs {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 8787)]
    port: u16,
}

#[derive(Debug, Args)]
struct RunArgs {
    #[arg(long)]
    auto: bool,
    #[arg(long, value_enum, default_value_t = AgentMode::Code)]
    mode: AgentMode,
    #[arg(value_name = "PROMPT", trailing_var_arg = true)]
    prompt: Vec<String>,
}

#[derive(Clone, Copy, Debug, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
enum AgentMode {
    Code,
    Plan,
    Ask,
    Debug,
    Review,
}

impl std::fmt::Display for AgentMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                AgentMode::Code => "code",
                AgentMode::Plan => "plan",
                AgentMode::Ask => "ask",
                AgentMode::Debug => "debug",
                AgentMode::Review => "review",
            }
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AxumConfig {
    provider: Option<String>,
    provider_config: Option<String>,
    #[serde(default)]
    providers: BTreeMap<String, ProviderConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProviderConfig {
    #[serde(rename = "type")]
    kind: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    models: Option<Vec<String>>,
    max_retries: Option<u32>,
    retry_min_delay_ms: Option<u64>,
    retry_max_delay_ms: Option<u64>,
    retry_delay_ms: Option<u64>,
    request_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct ResolvedProvider {
    id: String,
    base_url: String,
    api_key: Option<String>,
    api_key_source: String,
    model: String,
    models: Vec<String>,
    max_retries: u32,
    retry_min_delay_ms: u64,
    retry_max_delay_ms: u64,
    request_timeout_ms: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let code = run(cli).await?;
    std::process::exit(code);
}

async fn run(cli: Cli) -> Result<i32> {
    match cli.command.unwrap_or(Command::Tui(TuiArgs {
        chat: ChatArgs {
            model: None,
            system: None,
            temperature: None,
            max_retries: None,
            retry_min_delay_ms: None,
            retry_max_delay_ms: None,
            request_timeout_ms: None,
            json: false,
            prompt: vec![],
        },
        dry_run: false,
        no_alt_screen: false,
        mode: AgentMode::Code,
    })) {
        Command::Init(args) => run_init(cli.config, args),
        Command::Chat(args) => run_chat(cli.config, cli.provider, args).await,
        Command::Tui(args) => run_tui(cli.config, cli.provider, args).await,
        Command::Doctor(args) => run_doctor(cli.config, cli.provider, args).await,
        Command::Providers(args) => run_providers(cli.config, args),
        Command::Modes => run_modes(),
        Command::Workflow(args) => run_workflow(args),
        Command::Parallel(args) => run_parallel(args),
        Command::ConfigWeb(args) => run_config_web(args),
        Command::Run(args) => run_auto(cli.config, cli.provider, args).await,
    }
}

fn default_config_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| anyhow!("home directory not found"))?
        .join(".axum/config.toml"))
}

fn resolve_config_path(path: Option<PathBuf>) -> Result<PathBuf> {
    Ok(path.unwrap_or(default_config_path()?))
}

fn load_config(path: Option<PathBuf>) -> Result<(PathBuf, AxumConfig)> {
    let path = resolve_config_path(path)?;
    if !path.exists() {
        return Ok((path, AxumConfig::default()));
    }
    let text =
        fs::read_to_string(&path).with_context(|| format!("read config {}", path.display()))?;
    let cfg = toml::from_str(&text).with_context(|| format!("parse config {}", path.display()))?;
    Ok((path, cfg))
}

fn save_config(path: &Path, cfg: &AxumConfig) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, toml::to_string_pretty(cfg)?)?;
    Ok(())
}

fn parse_provider_config_line(line: &str) -> Result<(String, String, String)> {
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3 {
        return Err(anyhow!(
            "provider-config must be '<url> <key|env:VAR> <model>'"
        ));
    }
    Ok((
        parts[0].to_owned(),
        parts[1].to_owned(),
        parts[2].to_owned(),
    ))
}

fn run_init(config_path: Option<PathBuf>, args: InitArgs) -> Result<i32> {
    let path = resolve_config_path(config_path)?;
    if path.exists() && !args.force {
        println!("axum config exists: {}", path.display());
        println!("Use --force to update provider URL/key/model.");
        return Ok(0);
    }
    let (base_url, api_key, model) = if let Some(line) = args.provider_config.as_deref() {
        parse_provider_config_line(line)?
    } else {
        (
            args.base_url,
            args.api_key
                .unwrap_or_else(|| format!("env:{DEFAULT_API_KEY_ENV}")),
            args.model,
        )
    };
    let mut cfg = AxumConfig {
        provider: Some(DEFAULT_PROVIDER.to_owned()),
        ..Default::default()
    };
    cfg.providers.insert(
        DEFAULT_PROVIDER.to_owned(),
        ProviderConfig {
            kind: Some("openai-chat".to_owned()),
            base_url: Some(base_url.clone()),
            api_key: Some(api_key),
            model: Some(model.clone()),
            models: Some(vec![model.clone()]),
            max_retries: Some(DEFAULT_MAX_RETRIES),
            retry_min_delay_ms: Some(DEFAULT_RETRY_MIN_DELAY_MS),
            retry_max_delay_ms: Some(DEFAULT_RETRY_MAX_DELAY_MS),
            request_timeout_ms: Some(DEFAULT_REQUEST_TIMEOUT_MS),
            retry_delay_ms: None,
        },
    );
    save_config(&path, &cfg)?;
    println!(
        "axum config {}: {}",
        if path.exists() { "updated" } else { "created" },
        path.display()
    );
    println!("provider: {base_url}");
    println!("model: {model}");
    println!("Next: axum doctor && axum tui");
    Ok(0)
}

fn resolve_secret(value: Option<&str>) -> (Option<String>, String) {
    match value {
        Some(v) if v.starts_with("env:") => {
            let name = &v[4..];
            (env::var(name).ok(), format!("env:{name}"))
        }
        Some(v) => (Some(v.to_owned()), "literal".to_owned()),
        None => (
            env::var(DEFAULT_API_KEY_ENV).ok(),
            format!("env:{DEFAULT_API_KEY_ENV}"),
        ),
    }
}

fn resolve_provider(
    config_path: Option<PathBuf>,
    provider_id: Option<String>,
    chat: Option<&ChatArgs>,
) -> Result<ResolvedProvider> {
    let (_path, mut cfg) = load_config(config_path)?;
    if cfg.providers.is_empty() {
        if let Some(line) = cfg.provider_config.clone() {
            let (base_url, api_key, model) = parse_provider_config_line(&line)?;
            cfg.providers.insert(
                DEFAULT_PROVIDER.to_owned(),
                ProviderConfig {
                    kind: Some("openai-chat".to_owned()),
                    base_url: Some(base_url),
                    api_key: Some(api_key),
                    model: Some(model.clone()),
                    models: Some(vec![model]),
                    ..Default::default()
                },
            );
        }
    }
    let id = provider_id
        .or(cfg.provider.clone())
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_owned());
    let provider = cfg.providers.get(&id).cloned().unwrap_or_default();
    let base_url = env::var("AXUM_OPENAI_BASE_URL")
        .ok()
        .or(provider.base_url)
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
    let (api_key, api_key_source) = resolve_secret(provider.api_key.as_deref());
    let model = chat
        .and_then(|c| c.model.clone())
        .or_else(|| env::var("AXUM_MODEL").ok())
        .or(provider.model.clone())
        .or_else(|| provider.models.as_ref().and_then(|m| m.first().cloned()))
        .unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    let max_retries = chat
        .and_then(|c| c.max_retries)
        .or(provider.max_retries)
        .unwrap_or(DEFAULT_MAX_RETRIES);
    let retry_min_delay_ms = chat
        .and_then(|c| c.retry_min_delay_ms)
        .or(provider.retry_delay_ms)
        .or(provider.retry_min_delay_ms)
        .unwrap_or(DEFAULT_RETRY_MIN_DELAY_MS);
    let retry_max_delay_ms = chat
        .and_then(|c| c.retry_max_delay_ms)
        .or(provider.retry_delay_ms)
        .or(provider.retry_max_delay_ms)
        .unwrap_or(DEFAULT_RETRY_MAX_DELAY_MS);
    let request_timeout_ms = chat
        .and_then(|c| c.request_timeout_ms)
        .or(provider.request_timeout_ms)
        .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
    Ok(ResolvedProvider {
        id,
        base_url,
        api_key,
        api_key_source,
        model,
        models: provider.models.unwrap_or_default(),
        max_retries,
        retry_min_delay_ms,
        retry_max_delay_ms,
        request_timeout_ms,
    })
}

fn client(provider: &ResolvedProvider) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder();
    if provider.request_timeout_ms > 0 {
        builder = builder.timeout(Duration::from_millis(provider.request_timeout_ms));
    }
    Ok(builder.build()?)
}

async fn retrying<T, Fut, F>(provider: &ResolvedProvider, mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, reqwest::Error>>,
{
    let mut attempt = 0;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < provider.max_retries && is_retryable(&e) => {
                let delay = std::cmp::min(
                    provider.retry_max_delay_ms,
                    provider
                        .retry_min_delay_ms
                        .saturating_mul(1u64 << attempt.min(10)),
                );
                sleep(Duration::from_millis(delay)).await;
                attempt += 1;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

fn is_retryable(error: &reqwest::Error) -> bool {
    error.is_timeout()
        || error.is_connect()
        || error
            .status()
            .is_some_and(|s| s.is_server_error() || s == StatusCode::TOO_MANY_REQUESTS)
}

async fn run_chat(
    config_path: Option<PathBuf>,
    provider_id: Option<String>,
    args: ChatArgs,
) -> Result<i32> {
    let prompt = args.prompt.join(" ");
    if prompt.trim().is_empty() {
        return Err(anyhow!("chat prompt is required"));
    }
    let provider = resolve_provider(config_path, provider_id, Some(&args))?;
    let api_key = provider
        .api_key
        .clone()
        .ok_or_else(|| anyhow!("provider api key missing ({})", provider.api_key_source))?;
    let client = client(&provider)?;
    let mut messages = vec![];
    if let Some(system) = args.system.as_ref() {
        messages.push(json!({"role":"system","content": system}));
    }
    messages.push(json!({"role":"user","content": prompt}));
    let mut body = json!({"model": provider.model, "messages": messages});
    if let Some(temp) = args.temperature {
        body["temperature"] = json!(temp);
    }
    let url = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let res: serde_json::Value = retrying(&provider, || {
        client.post(&url).bearer_auth(&api_key).json(&body).send()
    })
    .await?
    .error_for_status()?
    .json()
    .await?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&res)?);
    } else {
        let text = res
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        println!("{text}");
    }
    Ok(0)
}

async fn fetch_models(provider: &ResolvedProvider) -> Result<Vec<String>> {
    let api_key = provider
        .api_key
        .clone()
        .ok_or_else(|| anyhow!("provider api key missing ({})", provider.api_key_source))?;
    let client = client(provider)?;
    let url = format!("{}/models", provider.base_url.trim_end_matches('/'));
    let res: serde_json::Value =
        retrying(provider, || client.get(&url).bearer_auth(&api_key).send())
            .await?
            .error_for_status()?
            .json()
            .await?;
    Ok(res
        .get("data")
        .and_then(|v| v.as_array())
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(str::to_owned))
        .collect())
}

async fn run_doctor(
    config_path: Option<PathBuf>,
    provider_id: Option<String>,
    args: DiagnosticArgs,
) -> Result<i32> {
    let provider = resolve_provider(config_path, provider_id, None)?;
    let models = fetch_models(&provider).await;
    let ok = models.is_ok();
    let report = json!({
        "provider": provider.id, "base_url": provider.base_url, "model": provider.model,
        "api_key_source": provider.api_key_source, "models_ok": ok,
        "models": models.as_ref().ok(), "error": models.err().map(|e| e.to_string())
    });
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else if ok {
        println!(
            "doctor ok\nprovider: {}\nmodel: {}",
            provider.id, provider.model
        );
    } else {
        println!(
            "doctor failed\n{}",
            report["error"].as_str().unwrap_or("unknown error")
        );
        return Ok(1);
    }
    Ok(0)
}

fn run_providers(config_path: Option<PathBuf>, args: DiagnosticArgs) -> Result<i32> {
    let (_path, cfg) = load_config(config_path)?;
    let rows: Vec<_> = cfg.providers.iter().map(|(id, p)| json!({"id": id, "type": p.kind, "base_url": p.base_url, "model": p.model, "models": p.models})).collect();
    if args.json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
    } else {
        for row in rows {
            println!(
                "{}  {}  {}",
                row["id"].as_str().unwrap_or(""),
                row["model"].as_str().unwrap_or(""),
                row["base_url"].as_str().unwrap_or("")
            );
        }
    }
    Ok(0)
}

fn run_modes() -> Result<i32> {
    println!("AxumAgent modes");
    for mode in [
        AgentMode::Code,
        AgentMode::Plan,
        AgentMode::Ask,
        AgentMode::Debug,
        AgentMode::Review,
    ] {
        println!("- {mode}");
    }
    Ok(0)
}

fn run_workflow(args: WorkflowArgs) -> Result<i32> {
    let prompt = args.prompt.join(" ");
    println!("◇ plan\n  mode: {}\n  prompt: {}", args.mode, prompt);
    println!("◇ now\n  Phase3 Rust workflow engine pending");
    println!("◇ evidence\n  Rust clap command surface is active");
    println!("◇ result\n  workflow skeleton rendered");
    println!("◇ next\n  implement Pi-style state machine in Phase3");
    println!("◇ issues\n  none");
    Ok(0)
}

fn run_parallel(args: ParallelArgs) -> Result<i32> {
    println!("◇ Axum parallel");
    println!("goal: {}", args.goal.join(" "));
    for (i, task) in args.tasks.iter().enumerate() {
        println!("{}. queued: {}", i + 1, task);
    }
    Ok(0)
}

fn run_config_web(args: ConfigWebArgs) -> Result<i32> {
    println!(
        "config-web is preserved as a CLI command; Rust web UI is out of scope for this CLI-only phase ({}:{})",
        args.host, args.port
    );
    Ok(0)
}

async fn run_tui(
    config_path: Option<PathBuf>,
    provider_id: Option<String>,
    args: TuiArgs,
) -> Result<i32> {
    let provider = resolve_provider(config_path, provider_id, Some(&args.chat))?;
    println!("AxumAgent Rust TUI");
    println!("mode: {}", args.mode);
    println!("provider: {}", provider.id);
    println!("model: {}", provider.model);
    if !provider.models.is_empty() {
        println!("models: {}", provider.models.join(", "));
    }
    println!("Ratatui interactive surface is Phase2; use `axum chat` for Phase1 provider calls.");
    Ok(0)
}

async fn run_auto(
    config_path: Option<PathBuf>,
    provider_id: Option<String>,
    args: RunArgs,
) -> Result<i32> {
    if !args.auto {
        return Err(anyhow!("autonomous run requires --auto"));
    }
    let prompt = args.prompt.join(" ");
    println!("auto mode enabled; mode: {}; prompt: {}", args.mode, prompt);
    let chat = ChatArgs {
        model: None,
        system: Some(format!(
            "You are AxumAgent in {} mode. Run without interactive permission prompts.",
            args.mode
        )),
        temperature: None,
        max_retries: None,
        retry_min_delay_ms: None,
        retry_max_delay_ms: None,
        request_timeout_ms: None,
        json: false,
        prompt: args.prompt,
    };
    run_chat(config_path, provider_id, chat).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_provider_config_line() {
        let (url, key, model) =
            parse_provider_config_line("https://example.test/v1 env:KEY m1").unwrap();
        assert_eq!(url, "https://example.test/v1");
        assert_eq!(key, "env:KEY");
        assert_eq!(model, "m1");
    }

    #[test]
    fn modes_render_stable_names() {
        assert_eq!(AgentMode::Code.to_string(), "code");
        assert_eq!(AgentMode::Review.to_string(), "review");
    }
}
