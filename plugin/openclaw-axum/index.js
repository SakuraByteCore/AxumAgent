import { randomUUID } from "node:crypto";

const CHANNEL = "openclaw-weixin";
const POLL_MS = 2000;
const HTTP_TIMEOUT_MS = 5000;
const DEFAULT_CHUNK_CHARS = 2000;
const MAX_TRACKED_TASKS = 100;

function createClient(env) {
  const url = new URL(env.AXUM_REMOTE_URL || "http://127.0.0.1:18791");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Axum 桥接仅允许回环地址；异机请使用端口隧道。");
  const token = env.AXUM_REMOTE_TOKEN;
  if (!token || token.length < 32) throw new Error("缺少 AXUM_REMOTE_TOKEN（至少 32 字符）。");
  return async (path, body, binding = "") => {
    const response = await fetch(new URL(path, url), {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Axum-Binding": binding },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  };
}

async function deliver(state, job) {
  const result = await state.request(`/tasks/${job.id}`, undefined, state.binding);
  if (!["completed", "failed"].includes(result.status)) return;
  const adapter = await state.api.runtime.channel.outbound.loadAdapter(CHANNEL);
  if (!adapter?.sendText) throw new Error("微信渠道 sendText 不可用。");
  const chars = Array.from(`[Axum ${job.id} · ${result.status}]\n${result.result}`);
  const limit = Math.min(adapter.textChunkLimit || DEFAULT_CHUNK_CHARS, DEFAULT_CHUNK_CHARS);
  while (job.offset < chars.length && !state.stopped) {
    await adapter.sendText({ cfg: state.api.config, to: state.config.senderId, accountId: state.config.accountId, text: chars.slice(job.offset, job.offset + limit).join("") });
    job.offset += limit;
  }
  if (!state.stopped) job.delivered = true;
}

async function poll(state) {
  if (state.polling || state.stopped) return;
  state.polling = true;
  try {
    for (const job of state.jobs.values()) {
      if (job.delivered || state.stopped) continue;
      try { await deliver(state, job); }
      catch (error) { state.api.logger.error(`Axum ${job.id} 结果回传未完成：${error.message}`); }
    }
  } finally { state.polling = false; }
}

async function command(state, args) {
  const status = await state.request("/status");
  if (status.closed) throw new Error("终端绑定已关闭。");
  if (args === "bind") {
    if (state.binding && state.binding !== status.binding && [...state.jobs.values()].some(job => !job.delivered)) {
      throw new Error("旧会话仍有未回传任务，请先查询结果并重启桥接服务后更换绑定。");
    }
    if (state.binding !== status.binding) state.jobs.clear();
    state.binding = status.binding;
    return { text: `已绑定当前 Axum 会话 ${status.sessionId}。发送 /axum <需求>；/axum status 查看状态。` };
  }
  if (!state.binding) return { text: "请先在终端 /remote on，再发送 /axum bind。" };
  if (status.binding !== state.binding) throw new Error("原工作会话已失效，请重新 /axum bind。");
  if (args === "status") return { text: JSON.stringify(status) };
  if (args.startsWith("result ")) return { text: JSON.stringify(await state.request(`/tasks/${encodeURIComponent(args.slice(7).trim())}`, undefined, state.binding)) };
  if (!args) return { text: "用法：/axum <需求>；/axum run <请求ID> <需求>；/axum status；/axum result <请求ID>。" };
  const explicit = /^run ([\w-]{1,100}) (.+)$/s.exec(args);
  const id = explicit?.[1] || randomUUID();
  const task = explicit?.[2] || args;
  if (!state.jobs.has(id) && state.jobs.size >= MAX_TRACKED_TASKS) throw new Error("任务记录已满，请在终端关闭后重新绑定。");
  const result = await state.request("/tasks", { id, task, binding: state.binding });
  if (!state.jobs.has(id)) state.jobs.set(id, { id, offset: 0, delivered: false });
  return { text: `Axum 已接收 ${id}，状态：${result.status}。结果将自动回传；可用 /axum result ${id} 查询。` };
}

export function registerAxumBridge(api, env = process.env) {
  const config = api.pluginConfig || {};
  if (!config.senderId || !config.accountId) throw new Error("必须配置微信 senderId 与 accountId。");
  const state = { api, config, request: createClient(env), jobs: new Map(), stopped: false, polling: false };
  let timer;
  api.registerCommand({
    name: "axum", description: "向绑定的 Axum 终端会话发送任务", acceptsArgs: true, requireAuth: true,
    async handler(ctx) {
      if ((ctx.channelId || ctx.channel) !== CHANNEL || !ctx.isAuthorizedSender || ctx.senderId !== config.senderId || ctx.accountId !== config.accountId) {
        return { text: "当前微信账号或发送方未授权使用 Axum。" };
      }
      try { return await command(state, (ctx.args || "").trim()); }
      catch (error) { return { text: `Axum 请求未确认完成：${error.message}。网络超时不代表未接收；有副作用的任务请用固定请求 ID 查询后再重试。` }; }
    },
  });
  api.registerService({
    id: "axum-result-relay",
    start() { state.stopped = false; timer = setInterval(() => poll(state), POLL_MS); timer.unref?.(); },
    stop() { state.stopped = true; clearInterval(timer); state.binding = undefined; },
  });
}

export default { id: "axum-bridge", name: "Axum Bridge", register: registerAxumBridge };
