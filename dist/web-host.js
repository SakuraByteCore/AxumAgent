"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelpRequested = void 0;
exports.parseWebHostArgs = parseWebHostArgs;
exports.resolveKiloCommand = resolveKiloCommand;
exports.startWebHost = startWebHost;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const SERVER_URL_RE = /(?:kilo|opencode) server listening on\s+(https?:\/\/[^\s]+)/i;
function html() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AxumAgent Kilo Chat</title>
<style>
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101114; color: #f2f2f3; }
  body { margin: 0; min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
  header { padding: 14px 18px; border-bottom: 1px solid #2a2d34; display: flex; align-items: center; gap: 12px; }
  header strong { letter-spacing: .01em; }
  #status { color: #9ca3af; font-size: 13px; }
  #log { padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
  .row { max-width: 980px; border: 1px solid #2a2d34; border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.45; }
  .user { align-self: flex-end; background: #19324a; }
  .assistant { align-self: flex-start; background: #17191f; }
  .system { align-self: center; color: #a7adbb; background: transparent; border-style: dashed; font-size: 13px; }
  form { border-top: 1px solid #2a2d34; padding: 12px; display: grid; grid-template-columns: 1fr auto; gap: 10px; }
  textarea { resize: vertical; min-height: 54px; max-height: 180px; border-radius: 10px; border: 1px solid #343844; background: #151820; color: #f2f2f3; padding: 10px; font: inherit; }
  button { border: 0; border-radius: 10px; padding: 0 18px; background: #e7e7ea; color: #111318; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: .45; cursor: not-allowed; }
</style>
</head>
<body>
<header><strong>AxumAgent · Kilo Chat</strong><span id="status">connecting…</span></header>
<main id="log"></main>
<form id="form"><textarea id="input" placeholder="Send a message to this Kilo session…"></textarea><button id="send" type="submit">Send</button></form>
<script>
(() => {
  const status = document.getElementById('status');
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const form = document.getElementById('form');
  const send = document.getElementById('send');
  const stateKey = 'axum.kiloChat.vscodeState';
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  function row(kind, text) {
    const div = document.createElement('div');
    div.className = 'row ' + kind;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  window.acquireVsCodeApi = function acquireVsCodeApi() {
    return {
      postMessage(message) { ws.send(JSON.stringify({ type: 'vscode.postMessage', message })); },
      getState() { try { return JSON.parse(sessionStorage.getItem(stateKey) || 'null'); } catch { return null; } },
      setState(value) { sessionStorage.setItem(stateKey, JSON.stringify(value)); return value; }
    };
  };
  ws.addEventListener('open', () => { status.textContent = 'connected'; row('system', 'connected to AxumAgent web host'); });
  ws.addEventListener('close', () => { status.textContent = 'disconnected'; send.disabled = true; row('system', 'connection closed'); });
  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { row('system', String(event.data)); return; }
    if (msg.type === 'axum.status') status.textContent = msg.message;
    else if (msg.type === 'axum.error') row('system', 'error: ' + msg.message);
    else if (msg.type === 'axum.assistant') row('assistant', msg.text || JSON.stringify(msg.data));
    else if (msg.type === 'kilo.event') {
      window.dispatchEvent(new MessageEvent('message', { data: msg.data }));
      const text = extractText(msg.data);
      if (text) row('assistant', text);
    }
    else row('system', JSON.stringify(msg, null, 2));
  });
  function extractText(value) {
    if (!value || typeof value !== 'object') return '';
    const direct = value.text || value.content || value.delta;
    if (typeof direct === 'string') return direct;
    for (const key of ['part', 'message', 'data']) {
      const nested = extractText(value[key]);
      if (nested) return nested;
    }
    return '';
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    row('user', text);
    input.value = '';
    ws.send(JSON.stringify({ type: 'axum.chat.send', text }));
  });
})();
</script>
</body>
</html>`;
}
function parsePort(value, flag) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
        throw new Error(`${flag} must be an integer from 0 to 65535`);
    return port;
}
function takeValue(args, index, flag) {
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value`);
    return value;
}
function parseWebHostArgs(args, env = process.env) {
    const options = {
        host: env.AXUM_WEB_HOST || DEFAULT_HOST,
        port: env.AXUM_WEB_PORT ? parsePort(env.AXUM_WEB_PORT, "AXUM_WEB_PORT") : DEFAULT_PORT,
        kiloBin: env.AXUM_KILO_BIN || "",
        kiloPackage: env.AXUM_KILO_PACKAGE || "@kilocode/cli@latest",
        workspace: env.AXUM_KILO_WORKSPACE || process.cwd(),
        idleTimeoutMs: env.AXUM_WEB_IDLE_TIMEOUT_MS ? parsePort(env.AXUM_WEB_IDLE_TIMEOUT_MS, "AXUM_WEB_IDLE_TIMEOUT_MS") : DEFAULT_IDLE_TIMEOUT_MS,
    };
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--host") {
            options.host = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--port") {
            options.port = parsePort(takeValue(args, i, arg), arg);
            i += 1;
        }
        else if (arg === "--kilo-bin") {
            options.kiloBin = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--kilo-package") {
            options.kiloPackage = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--workspace") {
            options.workspace = node_path_1.default.resolve(takeValue(args, i, arg));
            i += 1;
        }
        else if (arg === "--idle-timeout-ms") {
            options.idleTimeoutMs = parsePort(takeValue(args, i, arg), arg);
            i += 1;
        }
        else if (arg === "--help" || arg === "-h")
            throw new HelpRequested();
        else
            throw new Error(`unknown web option: ${arg}`);
    }
    return options;
}
class HelpRequested extends Error {
}
exports.HelpRequested = HelpRequested;
function isExecutable(file) {
    try {
        node_fs_1.default.accessSync(file, node_fs_1.default.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function findOnPath(command, env = process.env) {
    const pathValue = env.PATH || "";
    const extensions = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
    for (const dir of pathValue.split(node_path_1.default.delimiter)) {
        if (!dir)
            continue;
        for (const extension of extensions) {
            const candidate = node_path_1.default.join(dir, `${command}${extension}`);
            if (isExecutable(candidate))
                return candidate;
        }
    }
    return undefined;
}
function resolveKiloCommand(options, env = process.env) {
    if (options.kiloBin)
        return { command: options.kiloBin, argsPrefix: [], source: "explicit" };
    const localBinName = process.platform === "win32" ? "kilo.cmd" : "kilo";
    const localBin = node_path_1.default.join(options.workspace, "node_modules", ".bin", localBinName);
    if (isExecutable(localBin))
        return { command: localBin, argsPrefix: [], source: "workspace node_modules" };
    const pathKilo = findOnPath("kilo", env) || findOnPath("kilocode", env);
    if (pathKilo)
        return { command: pathKilo, argsPrefix: [], source: "PATH" };
    const npmExecPath = env.npm_execpath && isExecutable(env.npm_execpath) ? env.npm_execpath : undefined;
    const npx = npmExecPath || findOnPath("npx", env) || (process.platform === "win32" ? "npx.cmd" : "npx");
    return { command: npx, argsPrefix: ["--yes", options.kiloPackage], source: `npx ${options.kiloPackage}` };
}
class KiloSessionHost {
    options;
    child;
    serverUrl;
    sessionId;
    eventAbort;
    eventReady;
    sockets = new Map();
    idleTimer;
    starting;
    constructor(options) {
        this.options = options;
    }
    addSocket(socket) {
        this.sockets.set(socket.id, socket);
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        socket.writeJson({ type: "axum.status", message: this.serverUrl ? "kilo ready" : "connected" });
    }
    removeSocket(id) {
        this.sockets.delete(id);
        if (this.sockets.size === 0) {
            this.idleTimer = setTimeout(() => this.stop("idle timeout"), this.options.idleTimeoutMs);
        }
    }
    async handle(socket, input) {
        if (input.type === "axum.chat.send") {
            const text = typeof input.text === "string" ? input.text.trim() : "";
            if (!text)
                return;
            await this.sendPrompt(socket, text);
            return;
        }
        if (input.type === "vscode.postMessage") {
            socket.writeJson({ type: "axum.status", message: "vscode shim message received" });
            socket.writeJson({ type: "kilo.event", data: { type: "axum.webHost.unsupportedVscodeMessage", original: input.message } });
            return;
        }
        socket.writeJson({ type: "axum.error", message: `unsupported message type: ${String(input.type)}` });
    }
    closeSockets() {
        for (const socket of this.sockets.values())
            socket.close();
        this.sockets.clear();
    }
    stop(reason) {
        this.closeSockets();
        this.killChildTree("SIGTERM");
        this.eventAbort?.abort();
        this.eventAbort = undefined;
        this.eventReady = undefined;
        this.child = undefined;
        this.serverUrl = undefined;
        this.sessionId = undefined;
        this.broadcast({ type: "axum.status", message: `kilo stopped: ${reason}` });
    }
    killChildTree(signal) {
        const child = this.child;
        if (!child || child.killed)
            return;
        try {
            if (process.platform !== "win32" && child.pid) {
                process.kill(-child.pid, signal);
            }
            else {
                child.kill(signal);
            }
        }
        catch {
            try {
                child.kill(signal);
            }
            catch { /* already gone */ }
        }
    }
    async sendPrompt(socket, text) {
        const base = await this.ensureStarted();
        await this.eventReady;
        const sessionID = await this.ensureSession(base);
        socket.writeJson({ type: "axum.status", message: "sending prompt" });
        await this.postJson(`${base}/session/${encodeURIComponent(sessionID)}/message?directory=${encodeURIComponent(this.options.workspace)}`, {
            parts: [{ type: "text", text }],
        });
        socket.writeJson({ type: "axum.status", message: "prompt sent" });
    }
    ensureStarted() {
        if (this.serverUrl)
            return Promise.resolve(this.serverUrl);
        if (this.starting)
            return this.starting;
        this.starting = new Promise((resolve, reject) => {
            const kilo = resolveKiloCommand(this.options);
            this.broadcast({ type: "axum.status", message: `starting Kilo via ${kilo.source}` });
            const child = (0, node_child_process_1.spawn)(kilo.command, [...kilo.argsPrefix, "serve", "--port", "0"], {
                cwd: this.options.workspace,
                detached: process.platform !== "win32",
                env: { ...process.env, NO_COLOR: "1", KILO_APP_NAME: "axum-agent-web" },
            });
            this.child = child;
            let output = "";
            const failTimer = setTimeout(() => {
                this.killChildTree("SIGTERM");
                reject(new Error(`timed out waiting for Kilo serve to print a URL`));
            }, 20_000);
            const onData = (chunk) => {
                const text = chunk.toString("utf8");
                output += text;
                const match = output.match(SERVER_URL_RE) || output.match(/(https?:\/\/127\.0\.0\.1:\d+)/);
                if (match) {
                    clearTimeout(failTimer);
                    this.serverUrl = match[1].replace(/\/$/, "");
                    this.broadcast({ type: "axum.status", message: "kilo ready" });
                    this.eventReady = this.startEventStream(this.serverUrl);
                    resolve(this.serverUrl);
                }
            };
            child.stdout.on("data", onData);
            child.stderr.on("data", onData);
            child.on("error", (error) => { clearTimeout(failTimer); reject(error); });
            child.on("exit", (code, signal) => {
                clearTimeout(failTimer);
                this.child = undefined;
                this.serverUrl = undefined;
                this.sessionId = undefined;
                this.starting = undefined;
                const details = output.trim() ? `: ${output.trim().slice(-2000)}` : "";
                this.broadcast({ type: "axum.status", message: `kilo exited (${signal || (code ?? "unknown")})${details}` });
            });
        }).finally(() => { this.starting = undefined; });
        return this.starting;
    }
    startEventStream(base) {
        if (this.eventReady)
            return this.eventReady;
        const abort = new AbortController();
        this.eventAbort = abort;
        const url = `${base}/event?directory=${encodeURIComponent(this.options.workspace)}`;
        let markReady;
        const ready = new Promise((resolve) => { markReady = resolve; });
        fetch(url, { signal: abort.signal })
            .then(async (response) => {
            if (!response.ok || !response.body)
                throw new Error(`${response.status} ${response.statusText}`);
            markReady?.();
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                buffer += decoder.decode(next.value, { stream: true });
                const chunks = buffer.split(/\r?\n\r?\n/g);
                buffer = chunks.pop() || "";
                for (const chunk of chunks) {
                    const data = chunk.split(/\r?\n/g)
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    if (!data || data === "[DONE]")
                        continue;
                    try {
                        this.broadcast({ type: "kilo.event", data: JSON.parse(data) });
                    }
                    catch {
                        this.broadcast({ type: "kilo.event", data: { text: data } });
                    }
                }
            }
        })
            .catch((error) => {
            markReady?.();
            if (!abort.signal.aborted)
                this.broadcast({ type: "axum.error", message: `Kilo event stream failed: ${error instanceof Error ? error.message : String(error)}` });
        });
        return ready;
    }
    async ensureSession(base) {
        if (this.sessionId)
            return this.sessionId;
        const body = await this.postJson(`${base}/session?directory=${encodeURIComponent(this.options.workspace)}`, {
            title: "AxumAgent Web Chat",
            platform: "axum-web",
            metadata: { host: node_os_1.default.hostname(), createdBy: "axum-agent-web" },
        });
        const id = readSessionId(body);
        if (!id)
            throw new Error("Kilo /session response did not include a session id");
        this.sessionId = id;
        this.broadcast({ type: "axum.status", message: `session ${id}` });
        return id;
    }
    async postJson(url, body) {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok)
            throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
        if (!text)
            return null;
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    broadcast(value) {
        for (const socket of this.sockets.values())
            socket.writeJson(value);
    }
}
function readSessionId(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    for (const key of ["id", "sessionID", "sessionId"]) {
        if (typeof record[key] === "string")
            return record[key];
    }
    const data = record.data;
    if (data && typeof data === "object")
        return readSessionId(data);
    return undefined;
}
function websocketAccept(key) {
    return node_crypto_1.default.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}
function encodeFrame(text) {
    const payload = Buffer.from(text);
    if (payload.length < 126)
        return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    if (payload.length <= 65_535) {
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
        return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([header, payload]);
}
function decodeFrames(buffer) {
    const messages = [];
    let offset = 0;
    let close = false;
    while (offset + 2 <= buffer.length) {
        const first = buffer[offset];
        const second = buffer[offset + 1];
        const opcode = first & 0x0f;
        let length = second & 0x7f;
        let header = 2;
        if (length === 126) {
            if (offset + 4 > buffer.length)
                break;
            length = buffer.readUInt16BE(offset + 2);
            header = 4;
        }
        else if (length === 127) {
            if (offset + 10 > buffer.length)
                break;
            const big = buffer.readBigUInt64BE(offset + 2);
            if (big > BigInt(Number.MAX_SAFE_INTEGER))
                throw new Error("websocket frame too large");
            length = Number(big);
            header = 10;
        }
        const masked = Boolean(second & 0x80);
        const maskBytes = masked ? 4 : 0;
        if (offset + header + maskBytes + length > buffer.length)
            break;
        const mask = masked ? buffer.subarray(offset + header, offset + header + 4) : undefined;
        const payloadStart = offset + header + maskBytes;
        const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
        if (mask)
            for (let i = 0; i < payload.length; i += 1)
                payload[i] ^= mask[i % 4];
        if (opcode === 0x8)
            close = true;
        else if (opcode === 0x1)
            messages.push(payload.toString("utf8"));
        offset = payloadStart + length;
    }
    return { messages, rest: buffer.subarray(offset), close };
}
function attachWebSocket(req, socket, host) {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
        socket.destroy();
        return;
    }
    socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        "",
        "",
    ].join("\r\n"));
    const id = node_crypto_1.default.randomUUID();
    let pending = Buffer.alloc(0);
    const client = {
        id,
        writeJson(value) { if (!socket.destroyed)
            socket.write(encodeFrame(JSON.stringify(value))); },
        close() { socket.end(); },
    };
    host.addSocket(client);
    socket.on("data", (chunk) => {
        try {
            const decoded = decodeFrames(Buffer.concat([pending, chunk]));
            pending = decoded.rest;
            if (decoded.close)
                client.close();
            for (const message of decoded.messages) {
                let parsed;
                try {
                    parsed = JSON.parse(message);
                }
                catch {
                    client.writeJson({ type: "axum.error", message: "invalid JSON message" });
                    continue;
                }
                host.handle(client, parsed).catch((error) => client.writeJson({ type: "axum.error", message: error instanceof Error ? error.message : String(error) }));
            }
        }
        catch (error) {
            client.writeJson({ type: "axum.error", message: error instanceof Error ? error.message : String(error) });
        }
    });
    socket.on("close", () => host.removeSocket(id));
    socket.on("error", () => host.removeSocket(id));
}
async function startWebHost(options, stdout = process.stdout) {
    const host = new KiloSessionHost(options);
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const server = node_http_1.default.createServer((req, res) => {
        const url = new node_url_1.URL(req.url || "/", `http://${req.headers.host || `${options.host}:${options.port}`}`);
        if (req.method === "GET" && url.pathname === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(html());
            return;
        }
        if (req.method === "GET" && url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found\n");
    });
    server.on("upgrade", (req, socket) => {
        const url = new node_url_1.URL(req.url || "/", `http://${req.headers.host || `${options.host}:${options.port}`}`);
        if (url.pathname !== "/ws") {
            socket.destroy();
            return;
        }
        attachWebSocket(req, socket, host);
    });
    server.on("close", () => {
        host.stop("web host closed");
        resolveClosed?.();
    });
    const shutdown = () => {
        host.closeSockets();
        server.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise((resolve) => server.listen(options.port, options.host, resolve));
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : options.port;
    stdout.write(`AxumAgent Kilo Chat web host listening on http://${options.host}:${actualPort}\n`);
    await closed;
}
