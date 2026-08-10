import fs from "node:fs";
import path from "node:path";
import { isAndroidLike } from "./bundled-pi-platform.js";
import { getAgentDir } from "./provider-config.js";

export const DEFAULT_MCP_SERVER_NAME = "sequential-thinking";
export const DEFAULT_MCP_CONFIG = {
  mcpServers: {
    [DEFAULT_MCP_SERVER_NAME]: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
  },
};

export function getMcpConfigPath(env = process.env) {
  return path.join(getAgentDir(env), "mcp.json");
}

export function ensureDefaultMcpConfig({ env = process.env, platform = process.platform } = {}) {
  const file = getMcpConfigPath(env);
  if (isAndroidLike({ platform, env })) return { file, changed: false, skipped: "android" };
  if (fs.existsSync(file)) return { file, changed: false };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(DEFAULT_MCP_CONFIG, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try { fs.chmodSync(file, 0o600); } catch {}
    return { file, changed: true, config: DEFAULT_MCP_CONFIG };
  } catch (error) {
    if (error.code === "EEXIST") return { file, changed: false };
    throw error;
  }
}
