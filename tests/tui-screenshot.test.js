#!/usr/bin/env node

const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const { Terminal: XtermTerminal } = require("@xterm/headless");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const snapshotsDir = path.join(__dirname, "snapshots");
const updateSnapshots = process.env.AXUM_UPDATE_SNAPSHOTS === "1";

function requireScriptCommand() {
  const result = spawnSync("sh", ["-lc", "command -v script"], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, "tui screenshot tests need the POSIX `script` command to allocate a real TTY");
}

function startMockServer(models = ["m1", "very-long-model-name-beta"], responseDelayMs = 0) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      }, responseDelayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTtyCli(args, steps, size = {}) {
  requireScriptCommand();
  const command = [process.execPath, path.join(repoRoot, "bin", "axum.js"), ...args].map((part) => JSON.stringify(part)).join(" ");
  const columns = String(size.columns || 88);
  const rows = String(size.rows || 24);
  const child = spawn("script", ["-q", "/dev/null", "-c", command], {
    cwd: repoRoot,
    env: { ...process.env, OPENAI_API_KEY: "", AXUM_CONFIG: "", COLUMNS: columns, LINES: rows },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (const step of steps) {
    await delay(step.delayMs);
    child.stdin.write(step.input);
  }
  child.stdin.end();
  const code = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 8000);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  assert.strictEqual(code, 0, `TTY run failed with code ${code}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`);
  return stdout;
}

async function terminalViewport(raw, columns = 88, rows = 24) {
  const terminal = new XtermTerminal({ cols: columns, rows, disableStdin: true, allowProposedApi: true });
  await new Promise((resolve) => terminal.write(raw, resolve));
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    lines.push((line ? line.translateToString(true) : "").replace(/[ \t]+$/g, ""));
  }
  return lines.join("\n");
}

async function normalizeScreen(raw) {
  let text = await terminalViewport(raw);
  text = text
    .replaceAll(repoRoot, "<cwd>")
    .replace(/\/tmp\/[A-Za-z0-9._/-]+\/config\.toml/g, "<config>")
    .replace(/\/var\/folders\/[A-Za-z0-9._/-]+\/config\.toml/g, "<config>");
  return text.replace(/\n+$/g, "") + "\n";
}

function assertSnapshot(name, actual) {
  const file = path.join(snapshotsDir, `${name}.txt`);
  if (updateSnapshots) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, "utf8");
  assert.strictEqual(actual, expected, `${name} TUI screenshot snapshot changed. Run AXUM_UPDATE_SNAPSHOTS=1 npm test only when the new layout is intentional.`);
}

async function testSlashCommandPaletteScreenshot() {
  const raw = await runTtyCli(["tui", "--dry-run", "--no-alt-screen"], [
    { delayMs: 350, input: "/" },
    { delayMs: 350, input: "\x03" },
  ]);
  const snapshot = await normalizeScreen(raw);
  assert.ok(snapshot.includes("help"));
  assert.ok(snapshot.includes("show commands"));
  assert.ok(snapshot.includes("provider"));
  assert.ok(snapshot.includes("model"));
  assert.doesNotMatch(snapshot, /╭─ Prompt/);
  assert.doesNotMatch(snapshot, /▌ prompt/);
  assertSnapshot("slash-command-palette", snapshot);
}

async function testSlashCommandPaletteClearsOldRows() {
  const raw = await runTtyCli(["tui", "--dry-run", "--no-alt-screen"], [
    { delayMs: 350, input: "/" },
    { delayMs: 350, input: "\x1b[B" },
    { delayMs: 350, input: "\x1b[B" },
    { delayMs: 350, input: "\x03" },
  ]);
  const snapshot = await normalizeScreen(raw);
  assert.ok(!snapshot.includes("╭─ Commands"));
  assert.ok(snapshot.includes("show/set provider url/key") || snapshot.includes("fetch/list/switch models"));
}

async function testNarrowTerminalWidthDoesNotCrash() {
  const raw = await runTtyCli(["tui", "--dry-run", "--no-alt-screen"], [
    { delayMs: 350, input: "/" },
    { delayMs: 350, input: "\x1b[B" },
    { delayMs: 350, input: "hello\r" },
    { delayMs: 350, input: "/exit\r" },
  ], { columns: 51, rows: 24 });
  const snapshot = await terminalViewport(raw, 51, 24);
  assert.ok(snapshot.includes("AxumAgent"));
  assert.ok(!raw.includes("exceeds terminal width"));
}

async function testNarrowTerminalWideTextDoesNotCrash() {
  const raw = await runTtyCli(["tui", "--dry-run", "--no-alt-screen"], [
    { delayMs: 350, input: "中文宽字符测试✓◇◌·\r" },
    { delayMs: 350, input: "/exit\r" },
  ], { columns: 51, rows: 24 });
  const snapshot = await terminalViewport(raw, 51, 24);
  assert.ok(snapshot.includes("AxumAgent"));
  assert.ok(snapshot.includes("dry-run"));
  assert.ok(!raw.includes("exceeds terminal width"));
}

async function testBracketedPasteInInput() {
  const raw = await runTtyCli(["tui", "--dry-run", "--no-alt-screen"], [
    { delayMs: 350, input: "\x1b[200~hello from shift insert\x1b[201~" },
    { delayMs: 350, input: "\r" },
    { delayMs: 350, input: "/exit\r" },
  ]);
  const snapshot = await normalizeScreen(raw);
  assert.ok(snapshot.includes("hello from shift insert"));
  assert.ok(snapshot.includes("✓ dry-run · provider call skipped"));
}

async function testLongModelListStaysWithinViewport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-long-model-list-"));
  const config = path.join(dir, "config.toml");
  const models = Array.from({ length: 41 }, (_, index) => `model-${String(index + 1).padStart(2, "0")}`);
  fs.writeFileSync(config, `provider = "openai-chat"\n\n[providers.openai-chat]\ntype = "openai-chat"\nbase_url = "http://127.0.0.1:1/v1"\napi_key = "***"\nmodel = "model-41"\nmodels = ${JSON.stringify(models)}\n`);
  try {
    const raw = await runTtyCli(["tui", "--config", config, "--dry-run", "--no-alt-screen"], [
      { delayMs: 350, input: "/model\r" },
      { delayMs: 350, input: "/exit\r" },
    ]);
    const snapshot = await normalizeScreen(raw);
    assert.ok(snapshot.includes("  1  model-01"));
    assert.ok(snapshot.includes("▸ 41  model-41  current"));
    assert.ok(snapshot.includes("hidden before current"));
    assert.doesNotMatch(snapshot, /▌ prompt/);
    assert.ok(!snapshot.includes(" 21  model-21"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testBusyCtrlCOnlyCancelsRequest() {
  const { server, port } = await startMockServer(["m1"], 4000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-busy-cancel-"));
  const config = path.join(dir, "config.toml");
  fs.writeFileSync(config, `provider = "openai-chat"\n\n[providers.openai-chat]\ntype = "openai-chat"\nbase_url = "http://127.0.0.1:${port}/v1"\napi_key = "***"\nmodel = "m1"\nrequest_timeout_ms = 0\n`);
  try {
    const raw = await runTtyCli(["tui", "--config", config, "--no-alt-screen"], [
      { delayMs: 350, input: "hello\r" },
      { delayMs: 700, input: "\x03" },
      { delayMs: 700, input: "/exit\r" },
    ]);
    assert.ok(raw.includes("• Working"));
    assert.match(raw, /• Working \([^\r\n]*esc to interrupt\)/);
    assert.doesNotMatch(raw, /│ • Working \([^\r\n]*esc to interrupt\) │/);
    assert.ok(raw.includes("request cancelled; ready for the next prompt"));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testWorkingStatusDoesNotReplaceModelOutput() {
  const { server, port } = await startMockServer(["m1", "m2"], 900);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-working-model-output-"));
  const config = path.join(dir, "config.toml");
  fs.writeFileSync(config, `provider = "openai-chat"\n\n[providers.openai-chat]\ntype = "openai-chat"\nbase_url = "http://127.0.0.1:${port}/v1"\napi_key = "***"\nmodel = "m1"\n`);
  try {
    const raw = await runTtyCli(["tui", "--config", config, "--no-alt-screen"], [
      { delayMs: 350, input: "/model\r" },
      { delayMs: 350, input: "hello\r" },
      { delayMs: 1400, input: "/exit\r" },
    ]);
    assert.ok(raw.includes("model list refreshed"));
    assert.ok(raw.includes("• Working"));
    assert.ok(raw.indexOf("model list refreshed") < raw.indexOf("• Working"));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testModelListScreenshot() {
  const { server, port } = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-tui-shot-"));
  const config = path.join(dir, "config.toml");
  try {
    const raw = await runTtyCli(["tui", "--config", config, "--no-alt-screen"], [
      { delayMs: 350, input: `/provider url http://127.0.0.1:${port}/v1\r` },
      { delayMs: 800, input: "/provider key test-key\r" },
      { delayMs: 800, input: "/model\r" },
      { delayMs: 450, input: "/exit\r" },
    ]);
    const snapshot = await normalizeScreen(raw);
    assert.ok(snapshot.includes("models"));
    assert.ok(snapshot.includes("▸ 1  m1"));
    assert.ok(snapshot.includes("2  very-long-model-name-beta"));
    assertSnapshot("model-list", snapshot);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await testSlashCommandPaletteScreenshot();
  await testSlashCommandPaletteClearsOldRows();
  await testNarrowTerminalWidthDoesNotCrash();
  await testNarrowTerminalWideTextDoesNotCrash();
  await testBracketedPasteInInput();
  await testLongModelListStaysWithinViewport();
  await testBusyCtrlCOnlyCancelsRequest();
  await testWorkingStatusDoesNotReplaceModelOutput();
  await testModelListScreenshot();
  console.log("tui_screenshot_snapshots=True");
})();
