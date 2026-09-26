import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MCP_SERVERS_KEY,
  addMcpServer,
  buildServerEntry,
  existingMcpConfigFiles,
  getGlobalMcpPath,
  getProjectMcpPath,
  loadMcpConfig,
  parseArgsString,
  parseEnvString,
  removeMcpServer,
  validateMcpServerEntry,
} from "../src/mcp-config.js";

function makeOptions() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "axum-mcp-cwd-"));
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "axum-mcp-xdg-"));
  return {
    cwd,
    env: { XDG_CONFIG_HOME: configHome, HOME: configHome },
    paths: { project: path.join(cwd, ".mcp.json"), global: path.join(configHome, "mcp", "mcp.json") },
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

test("paths: project is <cwd>/.mcp.json, global honors XDG_CONFIG_HOME", () => {
  const options = makeOptions();
  assert.equal(getProjectMcpPath(options), options.paths.project);
  assert.equal(getGlobalMcpPath(options), options.paths.global);
});

test("loadMcpConfig: reads the mcpServers object", () => {
  const options = makeOptions();
  writeJson(options.paths.project, { [MCP_SERVERS_KEY]: { foo: { command: "bar" } } });
  assert.deepEqual(loadMcpConfig(options.paths.project), { foo: { command: "bar" } });
});

test("loadMcpConfig: throws on missing file, invalid JSON, and wrong shape", () => {
  const options = makeOptions();
  assert.throws(() => loadMcpConfig(options.paths.project), /failed to read/);
  writeJson(options.paths.project, "not-an-object");
  assert.throws(() => loadMcpConfig(options.paths.project), /must contain a "mcpServers" object/);
  fs.writeFileSync(options.paths.project, "{ broken");
  assert.throws(() => loadMcpConfig(options.paths.project), /invalid JSON/);
  writeJson(options.paths.project, { mcpServers: [] });
  assert.throws(() => loadMcpConfig(options.paths.project), /must contain a "mcpServers" object/);
});

test("validateMcpServerEntry: accepts stdio and http entries, rejects mixed or empty", () => {
  assert.ok(validateMcpServerEntry({ command: "npx" }));
  assert.ok(validateMcpServerEntry({ url: "https://example.com/mcp" }));
  assert.throws(() => validateMcpServerEntry({}), /must include a string "url" or "command"/);
  assert.throws(() => validateMcpServerEntry({ url: "https://a", command: "b" }), /cannot have both/);
  assert.throws(() => validateMcpServerEntry({ command: "npx", args: ["ok", 1] }), /"args" must be an array of strings/);
  assert.throws(() => validateMcpServerEntry({ command: "npx", env: { K: 1 } }), /"env" values must be strings/);
  assert.throws(() => validateMcpServerEntry({ command: "npx", headers: "bad" }), /"headers" must be an object/);
  assert.throws(() => validateMcpServerEntry("nope"), /must be an object/);
});

test("addMcpServer: falls back to global config when no project file exists", () => {
  const options = makeOptions();
  const file = addMcpServer("foo", { command: "npx", args: ["-y", "bar"] }, options);
  assert.equal(file, options.paths.global);
  const servers = loadMcpConfig(options.paths.global);
  assert.deepEqual(servers.foo, { command: "npx", args: ["-y", "bar"] });
});

test("addMcpServer: prefers the project file once it exists and preserves existing servers", () => {
  const options = makeOptions();
  writeJson(options.paths.project, { [MCP_SERVERS_KEY]: { existing: { command: "keep" } } });
  addMcpServer("foo", { command: "npx" }, options);
  const servers = loadMcpConfig(options.paths.project);
  assert.deepEqual(Object.keys(servers).sort(), ["existing", "foo"]);
  assert.equal(fs.existsSync(options.paths.global), false);
});

test("addMcpServer: --global flag forces the global file even with a project file present", () => {
  const options = makeOptions();
  writeJson(options.paths.project, { [MCP_SERVERS_KEY]: {} });
  const file = addMcpServer("foo", { command: "npx" }, { ...options, global: true });
  assert.equal(file, options.paths.global);
  assert.ok(loadMcpConfig(options.paths.global).foo);
});

test("addMcpServer: rejects duplicate names, invalid names, and invalid entries", () => {
  const options = makeOptions();
  addMcpServer("foo", { command: "npx" }, options);
  assert.throws(() => addMcpServer("foo", { command: "npx" }, options), /already has a server named "foo"/);
  assert.throws(() => addMcpServer("a/b", { command: "npx" }, options), /without slashes/);
  assert.throws(() => addMcpServer("foo", {}, options), /must include a string "url" or "command"/);
});

test("existingMcpConfigFiles: lists project first, global second, only when present", () => {
  const options = makeOptions();
  assert.deepEqual(existingMcpConfigFiles(options), []);
  writeJson(options.paths.project, { [MCP_SERVERS_KEY]: {} });
  assert.deepEqual(existingMcpConfigFiles(options), [options.paths.project]);
  writeJson(options.paths.global, { [MCP_SERVERS_KEY]: {} });
  assert.deepEqual(existingMcpConfigFiles(options), [options.paths.project, options.paths.global]);
});

test("removeMcpServer: removes from project first, then global, and keeps the rest", () => {
  const options = makeOptions();
  writeJson(options.paths.project, { [MCP_SERVERS_KEY]: { shared: { command: "p" } } });
  writeJson(options.paths.global, { [MCP_SERVERS_KEY]: { shared: { command: "g" }, only: { command: "x" } } });
  const file = removeMcpServer("shared", options);
  assert.equal(file, options.paths.project);
  assert.deepEqual(loadMcpConfig(options.paths.project), {});
  const second = removeMcpServer("shared", options);
  assert.equal(second, options.paths.global);
  assert.deepEqual(Object.keys(loadMcpConfig(options.paths.global)), ["only"]);
  assert.throws(() => removeMcpServer("missing", options), /no MCP server named "missing"/);
});

test("parseArgsString: splits on whitespace, empty yields no args", () => {
  assert.deepEqual(parseArgsString("npx -y foo"), ["npx", "-y", "foo"]);
  assert.deepEqual(parseArgsString("   "), []);
  assert.deepEqual(parseArgsString(""), []);
});

test("parseEnvString: parses KEY=VALUE pairs and rejects malformed ones", () => {
  assert.deepEqual(parseEnvString("A=1, B=two"), { A: "1", B: "two" });
  assert.deepEqual(parseEnvString(""), {});
  assert.deepEqual(parseEnvString("  "), {});
  assert.throws(() => parseEnvString("NOTAPAIR"), /invalid environment variable/);
  assert.throws(() => parseEnvString("A=1, BAD"), /invalid environment variable/);
});

test("buildServerEntry: splits a full stdio command line into command + args", () => {
  assert.deepEqual(buildServerEntry("npx -y some-server", ["--port", "3000"]), {
    command: "npx",
    args: ["-y", "some-server", "--port", "3000"],
  });
  assert.deepEqual(buildServerEntry("plain-binary"), { command: "plain-binary" });
});

test("buildServerEntry: http url becomes a remote entry; env is carried", () => {
  assert.deepEqual(buildServerEntry("https://api.example.com/mcp", [], { TOKEN: "t" }), {
    url: "https://api.example.com/mcp",
    env: { TOKEN: "t" },
  });
  assert.deepEqual(buildServerEntry("https://api.example.com/mcp"), { url: "https://api.example.com/mcp" });
  assert.throws(() => buildServerEntry("  "), /stdio command or http\(s\) url is required/);
});
