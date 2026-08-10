import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureDefaultMcpConfig, getMcpConfigPath } from "../src/default-mcp-config.js";

function testEnv() {
  return { PI_CODING_AGENT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "axum-mcp-config-")) };
}

test("creates the sequential-thinking MCP configuration on desktop", () => {
  const env = testEnv();
  const result = ensureDefaultMcpConfig({ env, platform: "linux" });

  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(getMcpConfigPath(env), "utf8")), {
    mcpServers: {
      "sequential-thinking": { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
    },
  });
});

test("preserves an existing MCP configuration", () => {
  const env = testEnv();
  const file = getMcpConfigPath(env);
  const existing = JSON.stringify({ mcpServers: { custom: { command: "custom-server" } } }, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing);

  const result = ensureDefaultMcpConfig({ env, platform: "win32" });

  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), existing);
});

test("does not create MCP configuration on Android", () => {
  const env = testEnv();
  const result = ensureDefaultMcpConfig({ env, platform: "android" });

  assert.equal(result.skipped, "android");
  assert.equal(fs.existsSync(getMcpConfigPath(env)), false);
});
