mod api;
mod cli;
mod output;
mod server;
mod types;

use cli::{Cli, Command, ConfigCommand, RunsCommand};
use server::ManagedServer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let base_url = cli.base_url();
    let client = reqwest::Client::builder().build()?;
    dispatch(&client, &base_url, &cli).await?;

    Ok(())
}

async fn dispatch(
    client: &reqwest::Client,
    base_url: &str,
    cli: &Cli,
) -> Result<(), Box<dyn std::error::Error>> {
    match &cli.command {
        Command::Config { command } => dispatch_config(command, cli.json).await,
        Command::Ping => output::ping(client, base_url, cli.json).await,
        Command::Health => output::health(client, base_url, cli.json).await,
        Command::Run { task, max_steps, spawn } => {
            let server = ManagedServer::maybe_start(client, spawn).await?;
            let effective_url = server.as_ref().map(|s| s.base_url.as_str()).unwrap_or(base_url);
            output::run(client, effective_url, task, *max_steps, cli.json).await
        }
        Command::Validate { spawn } => {
            let server = ManagedServer::maybe_start(client, spawn).await?;
            let effective_url = server.as_ref().map(|s| s.base_url.as_str()).unwrap_or(base_url);
            output::validate(client, effective_url, cli.json).await
        }
        Command::Runs { command } => dispatch_runs(client, base_url, command, cli.json).await,
    }
}

async fn dispatch_config(
    command: &ConfigCommand,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        ConfigCommand::Openai { base_url, api_key, model, timeout_ms, allow_mock } => {
            output::config_openai(base_url, api_key, model, *timeout_ms, *allow_mock, json).await
        }
        ConfigCommand::Show => output::config_show(json).await,
    }
}

async fn dispatch_runs(
    client: &reqwest::Client,
    base_url: &str,
    command: &RunsCommand,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        RunsCommand::Create { task, max_steps } => output::runs_create(client, base_url, task, *max_steps, json).await,
        RunsCommand::Get { run_id } => output::runs_get(client, base_url, run_id, json).await,
        RunsCommand::Events { run_id, from_seq } => output::runs_events(client, base_url, run_id, *from_seq, json).await,
    }
}
