import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 100000;
const REQUEST_TIMEOUT_MS = 10000;

function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header || "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("请求体超过限制。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

export async function startBridge({ queue, port, token }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("AXUM_REMOTE_TOKEN 至少需要 32 个字符。");
  const server = createServer(async (request, response) => {
    if (!authorized(request.headers.authorization, token)) return reply(response, 401, { error: "未授权。" });
    try {
      if (request.method === "GET" && request.url === "/status") return reply(response, 200, queue.status());
      if (request.method === "POST" && request.url === "/tasks") return reply(response, 202, queue.submit(await readBody(request)));
      if (request.method === "GET" && request.url.startsWith("/tasks/")) {
        if (request.headers["x-axum-binding"] !== queue.status().binding) return reply(response, 409, { error: "原工作会话绑定已失效。" });
        const task = queue.get(request.url.slice("/tasks/".length));
        return reply(response, task ? 200 : 404, task || { error: "任务不存在，进程可能已重启。" });
      }
      reply(response, 404, { error: "接口不存在。" });
    } catch (error) {
      reply(response, 400, { error: error.message });
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  return {
    port: server.address().port,
    async close() {
      queue.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
