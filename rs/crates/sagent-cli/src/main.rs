mod api;
mod cli;
mod output;
mod types;

use cli::{Cli, Command, RunsCommand};

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
        Command::Ping => output::ping(client, base_url, cli.json).await,
        Command::Health => output::health(client, base_url, cli.json).await,
        Command::Run { task, max_steps } => output::run(client, base_url, task, *max_steps, cli.json).await,
        Command::Runs { command } => dispatch_runs(client, base_url, command, cli.json).await,
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
