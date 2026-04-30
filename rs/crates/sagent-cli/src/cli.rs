use clap::{Parser, Subcommand};

const DEFAULT_URL: &str = "http://127.0.0.1:3001";

#[derive(Parser)]
#[command(name = "sagent-cli")]
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

impl Cli {
    pub fn parse() -> Self {
        <Self as Parser>::parse()
    }

    pub fn base_url(&self) -> String {
        self.url.trim_end_matches('/').to_string()
    }
}

