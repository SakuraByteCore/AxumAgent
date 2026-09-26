import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// MCP server configuration in the standard multi-host format shared by
// Cursor / Claude Code / Codex: a JSON file with an "mcpServers" object.
// The pi-mcp-adapter extension reads the project-level .mcp.json first and
// falls back to the global ~/.config/mcp/mcp.json. This module reads and
// writes those same files so users stay interoperable with other tools.

export const MCP_SERVERS_KEY = "mcpServers";
export const MCP_ADAPTER_PACKAGE = "pi-mcp-adapter";
export const MCP_ADAPTER_SPEC = "npm:pi-mcp-adapter@2.37.0";

const URL_PREFIX_RE = /^https?:\/\//;
const ENV_PAIR_RE = /^[^=\s]+=.+$/;

function optionEnv(options = {}) {
  return options.env || process.env;
}

function optionCwd(options = {}) {
  return options.cwd || process.cwd();
}

export function getProjectMcpPath(options = {}) {
  return path.join(optionCwd(options), ".mcp.json");
}

export function getGlobalMcpPath(options = {}) {
  const env = optionEnv(options);
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "mcp", "mcp.json");
}

// Load and validate one config file. Throws when the file is unreadable, the
// JSON is invalid, or the "mcpServers" shape is wrong; never returns a guess.
export function loadMcpConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`failed to read ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err.message}`);
  }
  const servers = data?.[MCP_SERVERS_KEY];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`${file} must contain a "${MCP_SERVERS_KEY}" object`);
  }
  return servers;
}

function assertStringMap(value, field, file) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: server "${field}" must be an object`);
  }
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      throw new Error(`${file}: server "${field}" values must be strings (${key})`);
    }
  }
}

export function validateMcpServerEntry(entry, file = "server entry") {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${file} must be an object`);
  }
  const hasUrl = typeof entry.url === "string" && entry.url.length > 0;
  const hasCommand = typeof entry.command === "string" && entry.command.length > 0;
  if (!hasUrl && !hasCommand) {
    throw new Error(`${file} must include a string "url" or "command"`);
  }
  if (hasUrl && hasCommand) {
    throw new Error(`${file} cannot have both "url" and "command"`);
  }
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) {
      throw new Error(`${file}: "args" must be an array of strings`);
    }
  }
  assertStringMap(entry.env, "env", file);
  assertStringMap(entry.headers, "headers", file);
  return true;
}

// Resolve which file a read or write should target: the project .mcp.json when
// it exists, otherwise the global config. Flags force one side explicitly.
function resolveTargetFile(options) {
  if (options.project) return getProjectMcpPath(options);
  if (options.global) return getGlobalMcpPath(options);
  const projectFile = getProjectMcpPath(options);
  if (fs.existsSync(projectFile)) return projectFile;
  return getGlobalMcpPath(options);
}

export function existingMcpConfigFiles(options = {}) {
  const candidates = [getProjectMcpPath(options), getGlobalMcpPath(options)];
  return candidates.filter((file) => fs.existsSync(file));
}

export function addMcpServer(name, entry, options = {}) {
  if (typeof name !== "string" || name.length === 0 || /[\/]/.test(name)) {
    throw new Error("server name must be a non-empty string without slashes");
  }
  validateMcpServerEntry(entry, `server entry "${name}"`);
  const file = resolveTargetFile(options);
  let servers = {};
  if (fs.existsSync(file)) servers = loadMcpConfig(file);
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new Error(`${file} already has a server named "${name}"`);
  }
  const next = { [MCP_SERVERS_KEY]: { ...servers, [name]: entry } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return file;
}

export function removeMcpServer(name, options = {}) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("server name must be a non-empty string");
  }
  for (const file of existingMcpConfigFiles(options)) {
    const servers = loadMcpConfig(file);
    if (Object.prototype.hasOwnProperty.call(servers, name)) {
      const next = { ...servers };
      delete next[name];
      fs.writeFileSync(file, JSON.stringify({ [MCP_SERVERS_KEY]: next }, null, 2) + "\n");
      return file;
    }
  }
  throw new Error(`no MCP server named "${name}" in project or global config`);
}

// Parse helper for the interactive CLI: "npx -y foo" -> ["npx", "-y", "foo"]
export function parseArgsString(argsString) {
  if (typeof argsString !== "string" || argsString.trim().length === 0) return [];
  return argsString.trim().split(/\s+/);
}

// Parse helper for the interactive CLI: "KEY=VALUE, KEY2=VALUE2" -> object
export function parseEnvString(envString) {
  if (typeof envString !== "string" || envString.trim().length === 0) return {};
  const env = {};
  for (const pair of envString.split(",")) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    if (!ENV_PAIR_RE.test(trimmed)) {
      throw new Error(`invalid environment variable (expected KEY=VALUE): ${trimmed}`);
    }
    const idx = trimmed.indexOf("=");
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return env;
}

// Build a server entry from raw interactive input: a http(s) url becomes a
// remote entry, anything else is a stdio command. A command line with
// arguments is split so the first token becomes "command" and the rest are
// prepended to "args"; a pasted full command line must not end up as a
// bogus single-token "command" in the config.
export function buildServerEntry(commandOrUrl, args = [], env = {}) {
  const input = typeof commandOrUrl === "string" ? commandOrUrl.trim() : "";
  if (input.length === 0) {
    throw new Error("a stdio command or http(s) url is required");
  }
  if (URL_PREFIX_RE.test(input)) {
    return { url: input, ...(Object.keys(env).length > 0 ? { env } : {}) };
  }
  const [command, ...inlineArgs] = input.split(/\s+/);
  const entry = { command };
  const allArgs = [...inlineArgs, ...args];
  if (allArgs.length > 0) entry.args = allArgs;
  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}
