use anyhow::{Context, Result, anyhow};
use clap::{Args, Parser, Subcommand, ValueEnum};
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    env, fs, io,
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
    let prompt = args.chat.prompt.join(" ");
    let mut state = TuiState::new(provider, args.mode);
    if !prompt.trim().is_empty() {
        state.input = prompt;
        state.cursor = state.input.len();
    }
    if args.dry_run || !crossterm::terminal::is_raw_mode_enabled().unwrap_or(false) && !at_tty() {
        println!("{}", render_tui_snapshot(&state, 90));
        return Ok(0);
    }
    run_ratatui_loop(state, args.no_alt_screen).await?;
    Ok(0)
}

fn at_tty() -> bool {
    std::io::IsTerminal::is_terminal(&io::stdout())
        && std::io::IsTerminal::is_terminal(&io::stdin())
}

#[derive(Debug, Clone)]
struct TuiState {
    provider: ResolvedProvider,
    mode: AgentMode,
    transcript: Vec<String>,
    input: String,
    cursor: usize,
    history: Vec<String>,
    history_index: Option<usize>,
    undo_stack: Vec<String>,
    killed: String,
    status: String,
    show_tasks: bool,
    show_commands: bool,
}

impl TuiState {
    fn new(provider: ResolvedProvider, mode: AgentMode) -> Self {
        Self {
            provider,
            mode,
            transcript: vec!["AxumAgent Rust TUI ready".to_owned()],
            input: String::new(),
            cursor: 0,
            history: vec![],
            history_index: None,
            undo_stack: vec![],
            killed: String::new(),
            status: "Working idle · /help for commands".to_owned(),
            show_tasks: false,
            show_commands: false,
        }
    }

    fn push_undo(&mut self) {
        if self.undo_stack.last() != Some(&self.input) {
            self.undo_stack.push(self.input.clone());
            if self.undo_stack.len() > 64 {
                self.undo_stack.remove(0);
            }
        }
    }

    fn insert_char(&mut self, ch: char) {
        self.push_undo();
        self.input.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
        self.history_index = None;
    }

    fn insert_text(&mut self, text: &str) {
        self.push_undo();
        self.input.insert_str(self.cursor, text);
        self.cursor += text.len();
        self.history_index = None;
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.push_undo();
        let prev = self.input[..self.cursor]
            .char_indices()
            .last()
            .map(|(i, _)| i)
            .unwrap_or(0);
        self.input.drain(prev..self.cursor);
        self.cursor = prev;
    }

    fn delete(&mut self) {
        if self.cursor >= self.input.len() {
            return;
        }
        self.push_undo();
        let next = self.input[self.cursor..]
            .char_indices()
            .nth(1)
            .map(|(i, _)| self.cursor + i)
            .unwrap_or(self.input.len());
        self.input.drain(self.cursor..next);
    }

    fn move_left(&mut self) {
        if self.cursor > 0 {
            self.cursor = self.input[..self.cursor]
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
        }
    }

    fn move_right(&mut self) {
        if self.cursor < self.input.len() {
            self.cursor = self.input[self.cursor..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| self.cursor + i)
                .unwrap_or(self.input.len());
        }
    }

    fn kill_line(&mut self) {
        self.push_undo();
        self.killed = self.input[self.cursor..].to_owned();
        self.input.truncate(self.cursor);
    }

    fn yank(&mut self) {
        let killed = self.killed.clone();
        self.insert_text(&killed);
    }

    fn undo(&mut self) {
        if let Some(previous) = self.undo_stack.pop() {
            self.input = previous;
            self.cursor = self.input.len();
        }
    }

    fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let idx = self
            .history_index
            .unwrap_or(self.history.len())
            .saturating_sub(1);
        self.history_index = Some(idx);
        self.input = self.history[idx].clone();
        self.cursor = self.input.len();
    }

    fn history_next(&mut self) {
        let Some(idx) = self.history_index else {
            return;
        };
        if idx + 1 >= self.history.len() {
            self.history_index = None;
            self.input.clear();
        } else {
            let next = idx + 1;
            self.history_index = Some(next);
            self.input = self.history[next].clone();
        }
        self.cursor = self.input.len();
    }
}

fn slash_commands() -> &'static [(&'static str, &'static str)] {
    &[
        ("/help", "show commands"),
        ("/tasks", "toggle Plan/Now/Evidence activity dashboard"),
        ("/providers", "list configured providers"),
        ("/provider", "show active provider"),
        ("/model", "show/fetch/switch model"),
        ("/mode", "switch Code/Plan/Ask/Debug/Review"),
        ("/exit", "exit TUI"),
        ("/quit", "exit TUI"),
    ]
}

fn command_suggestions(input: &str) -> Vec<String> {
    if !input.starts_with('/') {
        return vec![];
    }
    slash_commands()
        .iter()
        .filter(|(cmd, _)| cmd.starts_with(input.trim()))
        .map(|(cmd, desc)| format!("{cmd:<12} {desc}"))
        .collect()
}

fn render_tui_snapshot(state: &TuiState, width: usize) -> String {
    let mut lines = vec![
        format!("AxumAgent v0.1.0 · mode {}", state.mode),
        format!("{} · {}", state.provider.model, state.provider.id),
        "".to_owned(),
    ];
    lines.extend(state.transcript.iter().cloned());
    if state.show_tasks {
        lines.extend([
            "".to_owned(),
            "tasks".to_owned(),
            "Plan · collect user intent".to_owned(),
            "Now · interactive TUI".to_owned(),
            "Evidence · Ratatui frame active".to_owned(),
            "Result · pending provider turn".to_owned(),
            "Next · submit prompt or slash command".to_owned(),
            "Issues · none".to_owned(),
        ]);
    }
    let suggestions = command_suggestions(&state.input);
    if !suggestions.is_empty() || state.show_commands {
        lines.push("".to_owned());
        lines.push("commands".to_owned());
        lines.extend(if suggestions.is_empty() {
            slash_commands()
                .iter()
                .map(|(cmd, desc)| format!("{cmd:<12} {desc}"))
                .collect()
        } else {
            suggestions
        });
    }
    lines.push("".to_owned());
    lines.push(format!("{}", state.status));
    lines.push(format!("› {}", state.input));
    lines
        .into_iter()
        .map(|line| {
            if line.len() > width {
                line[..width].to_owned()
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn draw_tui(frame: &mut ratatui::Frame<'_>, state: &TuiState) {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(if state.show_tasks { 8 } else { 0 }),
            Constraint::Length(if state.show_commands || state.input.starts_with('/') {
                7
            } else {
                0
            }),
            Constraint::Length(4),
        ])
        .split(area);
    let header = Paragraph::new(vec![
        Line::from(vec![
            Span::styled("AxumAgent", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw(format!(" v0.1.0 · mode {}", state.mode)),
        ]),
        Line::from(format!("{} · {}", state.provider.model, state.provider.id)),
    ])
    .block(Block::default().borders(Borders::BOTTOM));
    frame.render_widget(header, chunks[0]);

    let transcript = Paragraph::new(state.transcript.join("\n"))
        .wrap(Wrap { trim: false })
        .block(Block::default().title("transcript").borders(Borders::ALL));
    frame.render_widget(transcript, chunks[1]);

    if state.show_tasks {
        let tasks = Paragraph::new("Plan · collect user intent\nNow · interactive TUI\nEvidence · Ratatui frame active\nResult · pending provider turn\nNext · submit prompt or slash command\nIssues · none")
            .block(Block::default().title("tasks").borders(Borders::ALL));
        frame.render_widget(tasks, chunks[2]);
    }

    if state.show_commands || state.input.starts_with('/') {
        let suggestions = command_suggestions(&state.input);
        let text = if suggestions.is_empty() {
            slash_commands()
                .iter()
                .map(|(cmd, desc)| format!("{cmd:<12} {desc}"))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            suggestions.join("\n")
        };
        let commands =
            Paragraph::new(text).block(Block::default().title("commands").borders(Borders::ALL));
        frame.render_widget(commands, chunks[3]);
    }

    let input = Paragraph::new(format!("{}\n› {}", state.status, state.input))
        .wrap(Wrap { trim: false })
        .block(Block::default().title("input").borders(Borders::ALL));
    let input_idx = chunks.len() - 1;
    frame.render_widget(input, chunks[input_idx]);
    let cursor_x = chunks[input_idx].x + 3 + state.input[..state.cursor].chars().count() as u16;
    let cursor_y = chunks[input_idx].y + 2;
    frame.set_cursor_position((
        cursor_x.min(chunks[input_idx].right().saturating_sub(1)),
        cursor_y,
    ));
}

async fn run_ratatui_loop(mut state: TuiState, no_alt_screen: bool) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    if !no_alt_screen {
        execute!(stdout, EnterAlternateScreen)?;
    }
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = async {
        loop {
            terminal.draw(|frame| draw_tui(frame, &state))?;
            if let Event::Key(key) = event::read()? {
                if handle_tui_key(&mut state, key).await? {
                    break;
                }
            }
        }
        Result::<()>::Ok(())
    }
    .await;
    disable_raw_mode()?;
    if !no_alt_screen {
        execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    }
    terminal.show_cursor()?;
    result
}

async fn handle_tui_key(state: &mut TuiState, key: KeyEvent) -> Result<bool> {
    match (key.code, key.modifiers) {
        (KeyCode::Char('c'), KeyModifiers::CONTROL) => return Ok(true),
        (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
            state.push_undo();
            state.killed = state.input[..state.cursor].to_owned();
            state.input.drain(..state.cursor);
            state.cursor = 0;
        }
        (KeyCode::Char('k'), KeyModifiers::CONTROL) => state.kill_line(),
        (KeyCode::Char('y'), KeyModifiers::CONTROL) => state.yank(),
        (KeyCode::Char('z'), KeyModifiers::CONTROL) => state.undo(),
        (KeyCode::Char('j'), KeyModifiers::CONTROL) => state.insert_char('\n'),
        (KeyCode::Char(ch), _) => state.insert_char(ch),
        (KeyCode::Backspace, _) => state.backspace(),
        (KeyCode::Delete, _) => state.delete(),
        (KeyCode::Left, _) => state.move_left(),
        (KeyCode::Right, _) => state.move_right(),
        (KeyCode::Home, _) => state.cursor = 0,
        (KeyCode::End, _) => state.cursor = state.input.len(),
        (KeyCode::Up, _) => state.history_prev(),
        (KeyCode::Down, _) => state.history_next(),
        (KeyCode::Enter, KeyModifiers::SHIFT) => state.insert_char('\n'),
        (KeyCode::Enter, _) => return submit_tui_input(state).await,
        (KeyCode::Esc, _) => state.show_commands = false,
        _ => {}
    }
    Ok(false)
}

async fn submit_tui_input(state: &mut TuiState) -> Result<bool> {
    let input = state.input.trim().to_owned();
    if input.is_empty() {
        return Ok(false);
    }
    state.history.push(state.input.clone());
    state.history_index = None;
    state.transcript.push(format!("› {input}"));
    state.input.clear();
    state.cursor = 0;
    if input == "/exit" || input == "/quit" {
        return Ok(true);
    }
    if input == "/help" {
        state.show_commands = true;
        state.status = "commands visible".to_owned();
    } else if input == "/tasks" {
        state.show_tasks = !state.show_tasks;
        state.status = if state.show_tasks {
            "tasks visible"
        } else {
            "tasks hidden"
        }
        .to_owned();
    } else if input == "/providers" {
        state.transcript.push(format!(
            "provider {} · {}",
            state.provider.id, state.provider.base_url
        ));
        state.status = "provider list rendered".to_owned();
    } else if input == "/provider" {
        state
            .transcript
            .push(format!("active provider: {}", state.provider.id));
        state.status = "provider rendered".to_owned();
    } else if input == "/model" {
        if state.provider.api_key.is_some() {
            state.status = "fetching models".to_owned();
            match fetch_models(&state.provider).await {
                Ok(models) if !models.is_empty() => {
                    state
                        .transcript
                        .push(format!("models: {}", models.join(", ")));
                    state.status = "model list refreshed".to_owned();
                }
                Ok(_) => state.status = "model list empty".to_owned(),
                Err(error) => state.status = format!("model fetch failed: {error}"),
            }
        } else if !state.provider.models.is_empty() {
            state
                .transcript
                .push(format!("models: {}", state.provider.models.join(", ")));
            state.status = "configured models rendered".to_owned();
        } else {
            state.status = format!("model: {}", state.provider.model);
        }
    } else if let Some(mode) = input.strip_prefix("/mode ") {
        if let Some(next) = parse_agent_mode(mode) {
            state.mode = next;
            state.status = format!("mode switched: {}", state.mode);
        } else {
            state.status = "unknown mode; use code/plan/ask/debug/review".to_owned();
        }
    } else if input.starts_with('/') {
        state.status = "unknown command".to_owned();
        state.show_commands = true;
    } else {
        state.status =
            "provider call pending; use `axum chat` for noninteractive Phase2 calls".to_owned();
        state.transcript.push("assistant · provider turn is wired through chat path; full streamed TUI turns land in Phase3".to_owned());
    }
    Ok(false)
}

fn parse_agent_mode(value: &str) -> Option<AgentMode> {
    match value.trim().to_ascii_lowercase().as_str() {
        "code" => Some(AgentMode::Code),
        "plan" => Some(AgentMode::Plan),
        "ask" => Some(AgentMode::Ask),
        "debug" => Some(AgentMode::Debug),
        "review" => Some(AgentMode::Review),
        _ => None,
    }
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

    #[test]
    fn slash_completion_filters_by_prefix() {
        let suggestions = command_suggestions("/pro");
        assert!(
            suggestions
                .iter()
                .any(|line| line.starts_with("/providers"))
        );
        assert!(suggestions.iter().any(|line| line.starts_with("/provider")));
        assert!(!suggestions.iter().any(|line| line.starts_with("/tasks")));
    }

    #[test]
    fn tui_editor_supports_history_undo_and_kill_ring() {
        let provider = ResolvedProvider {
            id: "test".to_owned(),
            base_url: "http://127.0.0.1/v1".to_owned(),
            api_key: None,
            api_key_source: "env:TEST".to_owned(),
            model: "m1".to_owned(),
            models: vec!["m1".to_owned()],
            max_retries: 0,
            retry_min_delay_ms: 1,
            retry_max_delay_ms: 1,
            request_timeout_ms: 1,
        };
        let mut state = TuiState::new(provider, AgentMode::Code);
        state.insert_text("abc");
        state.move_left();
        state.kill_line();
        assert_eq!(state.input, "ab");
        state.yank();
        assert_eq!(state.input, "abc");
        state.undo();
        assert_eq!(state.input, "ab");
        state.history.push("/tasks".to_owned());
        state.history_prev();
        assert_eq!(state.input, "/tasks");
    }

    #[test]
    fn tui_snapshot_contains_header_commands_and_input() {
        let provider = ResolvedProvider {
            id: "openai-chat".to_owned(),
            base_url: "http://127.0.0.1/v1".to_owned(),
            api_key: None,
            api_key_source: "env:OPENAI_API_KEY".to_owned(),
            model: "m1".to_owned(),
            models: vec!["m1".to_owned()],
            max_retries: 0,
            retry_min_delay_ms: 1,
            retry_max_delay_ms: 1,
            request_timeout_ms: 1,
        };
        let mut state = TuiState::new(provider, AgentMode::Plan);
        state.input = "/m".to_owned();
        let snapshot = render_tui_snapshot(&state, 90);
        assert!(snapshot.contains("AxumAgent v0.1.0 · mode plan"));
        assert!(snapshot.contains("/model"));
        assert!(snapshot.contains("› /m"));
    }
}
