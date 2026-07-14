#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultConfigPath() {
  return path.join(os.homedir(), ".axum", "config.toml");
}

function defaultConfigTemplate() {
  return [
    "# AxumAgent configuration",
    "# Created automatically during install if missing.",
    "",
    'model = "gpt-4o-mini"',
    'provider = "openai-chat"',
    "",
    '[providers.openai-chat]',
    'type = "openai-chat"',
    'base_url = "https://api.openai.com/v1"',
    'api_key = "env:OPENAI_API_KEY"',
    "max_retries = 10",
    "retry_delay_ms = 250",
    "",
  ].join("\n");
}

function ensureDefaultConfig() {
  const configPath = defaultConfigPath();
  if (fs.existsSync(configPath)) return { created: false, path: configPath };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, defaultConfigTemplate(), { encoding: "utf8", flag: "wx" });
  return { created: true, path: configPath };
}

if (require.main === module) {
  try {
    const result = ensureDefaultConfig();
    const action = result.created ? "created" : "exists";
    process.stdout.write(`axum config ${action}: ${result.path}\n`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`axum config skipped: ${message}\n`);
  }
}

module.exports = { defaultConfigPath, defaultConfigTemplate, ensureDefaultConfig };
