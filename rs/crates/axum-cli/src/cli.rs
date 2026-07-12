use clap::{Args, Parser, Subcommand};

const DEFAULT_URL: &str = "http://127.0.0.1:3001";

#[derive(Parser)]
#[command(name = "axum-cli")]
pub struct Cli {
    #[arg(long, default_value = DEFAULT_URL)]
    pub url: String,

    #[arg(long)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    Ping,
    Health,
    Run {
        task: String,
        #[arg(long)]
        max_steps: Option<u32>,
        #[command(flatten)]
        spawn: SpawnServerOptions,
    },
    Validate {
        #[command(flatten)]
        spawn: SpawnServerOptions,
    },
    Runs {
        #[command(subcommand)]
        command: RunsCommand,
    },
}

#[derive(Subcommand)]
pub enum ConfigCommand {
    Openai {
        #[arg(long)]
        base_url: String,

        #[arg(long)]
        api_key: String,

        #[arg(long)]
        model: String,

        #[arg(long, default_value_t = 60_000)]
        timeout_ms: u64,

        #[arg(long)]
        allow_mock: bool,
    },
    Show,
}

#[derive(Subcommand)]
pub enum RunsCommand {
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

#[derive(Args, Clone)]
pub struct SpawnServerOptions {
    #[arg(long)]
    pub spawn_server: bool,

    #[arg(long, default_value = "axum-server")]
    pub server_bin: String,

    #[arg(long = "server-arg")]
    pub server_args: Vec<String>,

    #[arg(long)]
    pub db_path: Option<String>,

    #[arg(long)]
    pub port: Option<u16>,

    #[arg(long, default_value_t = 10_000)]
    pub startup_timeout_ms: u64,
}

impl Cli {
    pub fn parse() -> Self {
        <Self as Parser>::parse()
    }

    pub fn base_url(&self) -> String {
        self.url.trim_end_matches('/').to_string()
    }
}
