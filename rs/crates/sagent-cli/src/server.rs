use std::net::TcpListener;
use std::path::Path;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::time::{sleep, Instant};

use crate::cli::SpawnServerOptions;

pub struct ManagedServer {
    child: Child,
    pub base_url: String,
}

impl ManagedServer {
    pub async fn maybe_start(
        client: &reqwest::Client,
        spawn: &SpawnServerOptions,
    ) -> Result<Option<Self>, Box<dyn std::error::Error>> {
        if !spawn.spawn_server {
            return Ok(None);
        }
        let server = Self::start(client, spawn).await?;
        Ok(Some(server))
    }

    async fn start(
        client: &reqwest::Client,
        spawn: &SpawnServerOptions,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let port = spawn.port.unwrap_or_else(pick_port);
        let db_path = spawn.db_path.clone().unwrap_or_else(default_db_path);
        let base_url = format!("http://127.0.0.1:{port}");

        let (bin, args) = resolve_server_command(spawn);
        let mut cmd = Command::new(bin);
        cmd.args(args);
        cmd.env("PORT", port.to_string());
        cmd.env("SAGENT_DB_PATH", db_path);
        let child = cmd.spawn()?;

        wait_health(client, &base_url, spawn.startup_timeout_ms).await?;
        Ok(Self { child, base_url })
    }
}

impl Drop for ManagedServer {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

fn resolve_server_command(spawn: &SpawnServerOptions) -> (String, Vec<String>) {
    let bin = resolve_server_bin(&spawn.server_bin);
    (bin, spawn.server_args.clone())
}

fn resolve_server_bin(bin: &str) -> String {
    if bin != "sagent-server" {
        return bin.to_string();
    }
    if Path::new("target/debug/sagent-server").exists() {
        return "target/debug/sagent-server".to_string();
    }
    if Path::new("rs/target/debug/sagent-server").exists() {
        return "rs/target/debug/sagent-server".to_string();
    }
    bin.to_string()
}

fn pick_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(3001)
}

fn default_db_path() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let pid = std::process::id();
    std::env::temp_dir()
        .join(format!("sagent-cli-{pid}-{ts}.db"))
        .to_string_lossy()
        .to_string()
}

async fn wait_health(
    client: &reqwest::Client,
    base_url: &str,
    timeout_ms: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if is_healthy(client, base_url).await {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }
    Err("server_start_timeout".into())
}

async fn is_healthy(client: &reqwest::Client, base_url: &str) -> bool {
    client
        .get(format!("{base_url}/health"))
        .send()
        .await
        .ok()
        .and_then(|r| r.error_for_status().ok())
        .is_some()
}
