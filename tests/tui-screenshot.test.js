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

function startMockServer(models = ["m1", "very-long-model-name-beta"]) {
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTtyCli(args, steps) {
  requireScriptCommand();
  const command = [process.execPath, path.join(repoRoot, "bin", "axum.js"), ...args].map((part) => JSON.stringify(part)).join(" ");
  const child = spawn("script", ["-q", "/dev/null", "-c", command], {
    cwd: repoRoot,
    env: { ...process.env, OPENAI_API_KEY: "", AXUM_CONFIG: "", COLUMNS: "88", LINES: "24" },
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
  assert.ok(snapshot.includes("commands"));
  assert.ok(snapshot.includes("› /help"));
  assert.ok(snapshot.includes("/model"));
  assertSnapshot("slash-command-palette", snapshot);
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
    assert.ok(snapshot.includes("Select model"));
    assert.ok(snapshot.includes("● 1  m1"));
    assert.ok(snapshot.includes("2  very-long-model-name-beta"));
    assertSnapshot("model-list", snapshot);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await testSlashCommandPaletteScreenshot();
  await testModelListScreenshot();
  console.log("tui_screenshot_snapshots=True");
})();
