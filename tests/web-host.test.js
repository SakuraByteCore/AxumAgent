#!/usr/bin/env node

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { parseWebHostArgs, resolveKiloCommand } = require("../dist/web-host.js");

const root = path.resolve(__dirname, "..");

function writeMockKilo(dir) {
  const script = path.join(dir, "mock-kilo.js");
  const pidFile = path.join(dir, "mock-kilo.pid");
  const callsFile = path.join(dir, "mock-kilo-calls.jsonl");
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const pidFile = ${JSON.stringify(pidFile)};
const callsFile = ${JSON.stringify(callsFile)};
if (process.argv[2] !== 'serve') process.exit(2);
fs.writeFileSync(pidFile, String(process.pid));
const eventClients = new Set();
function record(value) { fs.appendFileSync(callsFile, JSON.stringify(value) + '\\n'); }
function emit(value) {
  const line = 'event: message\\r\\ndata: ' + JSON.stringify(value) + '\\r\\n\\r\\n';
  for (const res of eventClients) res.write(line);
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/event')) {
    record({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    eventClients.add(res);
    res.write(': ready\\r\\n\\r\\n');
    req.on('close', () => eventClients.delete(res));
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    record({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url.startsWith('/session?')) {
      res.end(JSON.stringify({ id: 'mock-session-web' }));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/session/mock-session-web/message')) {
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => emit({ type: 'message.part.updated', part: { text: 'mock assistant reply' } }), 20);
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found', url: req.url }));
  });
});
server.listen(0, '127.0.0.1', () => console.log('kilo server listening on http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  fs.chmodSync(script, 0o755);
  return { script, pidFile, callsFile };
}

function startWebHost(kiloBin, workspace) {
  const child = spawn(process.execPath, [path.join(root, "bin", "axum.js"), "web", "--port", "0", "--kilo-bin", kiloBin, "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`web host did not start\nstdout=${stdout}\nstderr=${stderr}`)), 5000);
    child.stdout.on("data", () => {
      const match = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]), stdout: () => stdout, stderr: () => stderr });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`web host exited early with ${code}\nstdout=${stdout}\nstderr=${stderr}`));
    });
  });
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126, "test message should fit a small frame");
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, out]);
}

function decodeServerFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    let length = buffer[offset + 1] & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      throw new Error("test decoder does not support huge frames");
    }
    if (offset + header + length > buffer.length) break;
    messages.push(buffer.subarray(offset + header, offset + header + length).toString("utf8"));
    offset += header + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

function sendChat(port, text) {
  const key = crypto.randomBytes(16).toString("base64");
  const socket = net.connect(port, "127.0.0.1");
  let handshake = false;
  let buffer = Buffer.alloc(0);
  const messages = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for assistant reply\nmessages=${messages.join("\n")}`)), 5000);
    socket.on("connect", () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshake) {
        const sep = buffer.indexOf("\r\n\r\n");
        if (sep < 0) return;
        const head = buffer.subarray(0, sep).toString("utf8");
        assert.match(head, /101 Switching Protocols/);
        handshake = true;
        buffer = buffer.subarray(sep + 4);
        socket.write(encodeFrame(JSON.stringify({ type: "axum.chat.send", text })));
      }
      const decoded = decodeServerFrames(buffer);
      buffer = decoded.rest;
      messages.push(...decoded.messages);
      if (messages.some((message) => message.includes("mock assistant reply"))) {
        clearTimeout(timer);
        socket.end();
        resolve(messages);
      }
    });
    socket.on("error", reject);
  });
}

async function waitForGone(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process still alive: ${pid}`);
}

(async () => {
  const parsed = parseWebHostArgs([], { PATH: "", AXUM_KILO_PACKAGE: "@kilocode/cli@test" });
  assert.strictEqual(parsed.kiloBin, "");
  assert.strictEqual(parsed.kiloPackage, "@kilocode/cli@test");
  const fallback = resolveKiloCommand({ ...parsed, workspace: root }, { PATH: "" });
  assert.ok(fallback.argsPrefix.includes("@kilocode/cli@test"));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-host-test-"));
  const mock = writeMockKilo(dir);
  const host = await startWebHost(mock.script, root);
  try {
    const messages = await sendChat(host.port, "hello web host");
    assert.ok(messages.some((message) => message.includes("prompt sent")), messages.join("\n"));
    assert.ok(messages.some((message) => message.includes("mock assistant reply")), messages.join("\n"));
    const calls = fs.readFileSync(mock.callsFile, "utf8").trim().split(/\n/g).map((line) => JSON.parse(line));
    assert.ok(calls.some((call) => call.method === "GET" && call.url.startsWith("/event?")), JSON.stringify(calls));
    const prompt = calls.find((call) => call.method === "POST" && call.url.startsWith("/session/mock-session-web/message"));
    assert.ok(prompt, JSON.stringify(calls));
    assert.match(prompt.body, /hello web host/);
  } finally {
    const pid = fs.existsSync(mock.pidFile) ? Number(fs.readFileSync(mock.pidFile, "utf8")) : undefined;
    host.child.kill("SIGTERM");
    await new Promise((resolve) => host.child.once("close", resolve));
    if (pid) await waitForGone(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
