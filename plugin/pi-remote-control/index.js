import { createTaskQueue } from "./queue.js";
import { startBridge } from "./server.js";

const DEFAULT_PORT = 18791;

export default function remoteControl(pi) {
  let bridge;
  let queue;
  async function stop() {
    const previous = bridge;
    bridge = undefined;
    queue = undefined;
    if (previous) await previous.close();
  }
  pi.registerCommand("remote", {
    description: "绑定当前会话供微信控制：/remote on|off|status",
    async handler(args, ctx) {
      const action = args.trim();
      if (action === "off") { await stop(); ctx.ui.notify("远程绑定已关闭。", "info"); return; }
      if (action === "status") { ctx.ui.notify(JSON.stringify(queue?.status() || { connected: false }), "info"); return; }
      if (action !== "on") { ctx.ui.notify("用法：/remote on|off|status", "warning"); return; }
      if (bridge) { ctx.ui.notify("当前会话已绑定。", "info"); return; }
      const candidate = createTaskQueue({
        sessionId: ctx.sessionManager.getSessionId(),
        isIdle: () => ctx.isIdle(),
        send: text => pi.sendUserMessage(text, { streamingBehavior: "followUp", expandPromptTemplates: false }),
      });
      try {
        bridge = await startBridge({ queue: candidate, port: Number(process.env.AXUM_REMOTE_PORT || DEFAULT_PORT), token: process.env.AXUM_REMOTE_TOKEN });
        queue = candidate;
        ctx.ui.notify(`远程绑定已开启：127.0.0.1:${bridge.port}。微信发送 /axum bind。`, "info");
      } catch (error) { ctx.ui.notify(`远程绑定失败：${error.message}`, "error"); }
    },
  });
  pi.on("input", (event, ctx) => {
    if (queue && !queue.input(event.text)) {
      ctx.ui.notify("远程任务执行中，请完成后重发本地输入，或先 /remote off。", "warning");
      return { action: "handled" };
    }
    return { action: "continue" };
  });
  pi.on("message_end", event => queue?.message(event.message));
  pi.on("agent_settled", () => queue?.settled());
  pi.on("session_start", stop);
  pi.on("session_shutdown", stop);
}
