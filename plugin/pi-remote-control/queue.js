import { randomUUID } from "node:crypto";

export const MAX_TASKS = 100;
export const MAX_TASK_CHARS = 16000;

/** One bound terminal session; no transcript files or detached sessions. */
export function createTaskQueue({ send, isIdle, sessionId }) {
  const tasks = new Map();
  const bindingId = randomUUID();
  let active;
  let closed = false;
  const publicTask = ({ prompt, ...task }) => task;
  function pump() {
    if (closed || active || !isIdle()) return;
    active = [...tasks.values()].find(task => task.status === "queued");
    if (!active) return;
    active.status = "running";
    try { send(active.prompt); }
    catch (error) {
      active.status = "failed";
      active.result = error.message;
      active = undefined;
      queueMicrotask(pump);
    }
  }
  return {
    sessionId,
    submit({ id, task, binding }) {
      if (closed || binding !== bindingId) throw new Error("工作会话绑定已失效，请重新绑定。");
      if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) throw new Error("请求 ID 无效。");
      if (typeof task !== "string" || !task.trim() || task.length > MAX_TASK_CHARS) throw new Error("任务内容为空或超过长度限制。");
      if (tasks.has(id)) {
        if (tasks.get(id).task !== task) throw new Error("请求 ID 已用于另一任务。");
        return publicTask(tasks.get(id));
      }
      if (tasks.size >= MAX_TASKS) throw new Error("任务记录已满，请在终端重新绑定后继续。");
      tasks.set(id, { id, task, status: "queued", result: "", prompt: `[微信远程任务 ${randomUUID()}]\n${task}` });
      pump();
      return publicTask(tasks.get(id));
    },
    get(id) { const task = tasks.get(id); return task && publicTask(task); },
    status() { return { sessionId, binding: bindingId, closed, active: active?.id, queued: [...tasks.values()].filter(t => t.status === "queued").length }; },
    input(text) { return !active || text === active.prompt; },
    message(message) {
      if (!active || message.role !== "assistant") return;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        active.error = message.errorMessage || message.stopReason;
      } else {
        delete active.error;
      }
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text) active.result = text;
    },
    settled() {
      if (active) {
        active.status = active.error || !active.result ? "failed" : "completed";
        if (active.error) active.result = active.error;
        if (!active.result) active.result = "执行结束，但没有可回传的文本结果。";
        active = undefined;
      }
      queueMicrotask(pump);
    },
    close() {
      closed = true;
      for (const task of tasks.values()) {
        if (["queued", "running"].includes(task.status)) {
          task.status = "failed";
          task.result = "绑定已关闭；已开始的操作不会回滚，请在终端核查。";
        }
      }
      active = undefined;
    },
  };
}
