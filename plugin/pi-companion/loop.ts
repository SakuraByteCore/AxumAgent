import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLoopArguments } from "./loop-cron.ts";
import { isLoopSnapshot, LOOP_ENTRY, LOOP_RUNNING, LoopScheduler, type LoopTask, type SchedulerOptions } from "./loop-scheduler.ts";

const TICK_MS = 1000;
const DEFAULT_PROMPT_BYTES = 25_000;
export const MAINTENANCE_PROMPT = `继续本会话尚未完成的工作；完成后维护当前分支的 PR：处理审查评论、失败 CI 和合并冲突；没有待办时检查缺陷或简化代码。沿用本会话权限与用户授权，推送、删除或发布仍须具备对应授权。`;
const HELP = "/loop [30s|5m|2h|1d] [提示词]；/loop <提示词> every 2 hours；/loop list；/loop cancel <id|all>。无间隔时重复执行，验收通过才自动停止；可选 1 分钟至 1 小时的下轮延迟，未指定则本轮结束后立即续跑。无提示词时使用 loop.md 或维护任务。";

export async function readLoopPrompt(cwd: string, home: string = homedir()): Promise<string> {
  const paths = [join(cwd, ".pi", "loop.md"), join(cwd, ".claude", "loop.md"), join(home, ".pi", "agent", "loop.md"), join(home, ".claude", "loop.md")];
  for (const path of paths) {
    let file;
    try { file = await open(path, "r"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(DEFAULT_PROMPT_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      // Avoid a replacement character when truncation splits a UTF-8 codepoint.
      return new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, bytesRead), { stream: true });
    } finally { await file.close(); }
  }
  return MAINTENANCE_PROMPT;
}

function disabled(): boolean {
  return process.env.AXUM_DISABLE_CRON === "1" || process.env.CLAUDE_CODE_DISABLE_CRON === "1";
}
function describe(task: LoopTask): string {
  const schedule = task.dynamic ? "动态单次唤醒" : `${task.schedule}${task.recurring ? "（循环）" : "（单次）"}`;
  const next = task.nextRun === LOOP_RUNNING ? "本轮执行中" : `下次 ${new Date(task.nextRun).toLocaleString()}`;
  return `${task.id} · ${schedule} · ${next} · ${task.useDefault ? "loop.md / 维护任务" : task.prompt}`;
}
function result(text: string) { return { content: [{ type: "text" as const, text }], details: {} }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function registerLoop(pi: ExtensionAPI, options: SchedulerOptions = {}): void {
  const scheduler = new LoopScheduler(options);
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let immediate: ReturnType<typeof setImmediate> | undefined;
  let removeKeys: (() => void) | undefined;
  let generation = 0;
  let dispatching = false;
  const identity = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? "memory";
  const save = () => {
    if (context && identity(context) === sessionId) pi.appendEntry?.(LOOP_ENTRY, scheduler.snapshot(context.cwd));
    context?.ui.setStatus?.("loop", scheduler.list().length ? `↻ ${scheduler.list().length} 个调度任务` : undefined);
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    if (immediate) clearImmediate(immediate);
    timer = immediate = undefined;
  };
  const dispatch = () => {
    void tick().catch(error => {
      stopTimer(); scheduler.clear(); context = undefined;
      console.error(`/loop 调度已停止：${errorText(error)}`);
    });
  };
  const dispatchReadyDynamic = () => {
    if (immediate || disabled() || !scheduler.due()?.dynamic) return;
    // Yield past Pi's settled hooks before checking idle and pending user input.
    immediate = setImmediate(() => { immediate = undefined; dispatch(); });
    immediate.unref?.();
  };
  const arm = () => {
    if (disabled() || !scheduler.list().length) { stopTimer(); return; }
    if (!timer) {
      timer = setInterval(dispatch, TICK_MS);
      timer.unref?.();
    }
  };
  const changed = () => { save(); arm(); };
  const adopt = (ctx: ExtensionContext) => {
    if (sessionId !== undefined && identity(ctx) !== sessionId) throw new Error("会话已切换，请在当前会话重新调度。");
    context = ctx;
    sessionId = identity(ctx);
  };

  async function tick(): Promise<void> {
    const ctx = context;
    if (!ctx || dispatching || scheduler.busy || disabled() || identity(ctx) !== sessionId || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const task = scheduler.due();
    if (!task) return;
    const currentGeneration = generation;
    dispatching = true;
    try {
      const prompt = task.useDefault ? await readLoopPrompt(ctx.cwd) : task.prompt;
      // File reads yield to user input/session switches; recheck before dispatch.
      if (generation !== currentGeneration || identity(ctx) !== sessionId || disabled() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      if (!scheduler.begin(task.id)) return;
      const instruction = task.dynamic
        ? `\n\n[动态 /loop ${task.id}] 每轮执行上面的提示词，并核对其验收条件。只有确认全部通过才调用 ScheduleWakeup({ stop: true })；有失败、阻塞或缺少证据时不得标记通过。未通过时可调用 ScheduleWakeup 指定下轮延迟 delaySeconds（60–3600）及原因 reason；不调用则本轮结束后立即续跑。不要另建计时任务。`
        : "";
      // Plain text preserves skill visibility/permission checks and cannot execute /clear etc.
      await pi.sendUserMessage(prompt + instruction, { deliverAs: "followUp", expandPromptTemplates: false });
      if (generation === currentGeneration) changed();
    } catch (error) {
      if (generation === currentGeneration) {
        scheduler.failed(task.id);
        ctx.ui.notify(`/loop 投递失败：${errorText(error)}`, "error");
        changed();
      }
    } finally { dispatching = false; }
  }

  pi.registerCommand("loop", {
    description: "按时间重复提示词：/loop [间隔] [提示词]；list；cancel <id|all>",
    getArgumentCompletions: prefix => ["list", "cancel", "help"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      try {
        adopt(ctx);
        const text = args.trim();
        if (text === "help") { ctx.ui.notify(HELP, "info"); return; }
        if (text === "list") { ctx.ui.notify(scheduler.list().map(describe).join("\n") || "当前会话没有调度任务。", "info"); return; }
        const cancel = /^cancel(?:\s+(\S+))?$/.exec(text);
        if (cancel) {
          if (!cancel[1]) throw new Error("用法：/loop cancel <id|all>");
          if (cancel[1] === "all") { for (const task of scheduler.list()) scheduler.delete(task.id); }
          else if (!scheduler.delete(cancel[1])) throw new Error(`找不到任务：${cancel[1]}`);
          changed(); ctx.ui.notify("已取消后续调度。", "info"); return;
        }
        if (disabled()) throw new Error("调度已关闭：AXUM_DISABLE_CRON / CLAUDE_CODE_DISABLE_CRON。");
        const parsed = parseLoopArguments(text);
        const task = scheduler.create({ prompt: parsed.prompt, schedule: parsed.schedule, useDefault: !parsed.prompt });
        changed();
        const rounded = parsed.actualMinutes !== parsed.requestedMinutes ? `间隔已取整为 ${parsed.actualMinutes} 分钟。\n` : "";
        ctx.ui.notify(`${rounded}${describe(task)}\n循环任务七天后过期；仅在当前会话运行时触发。`, "info");
        if (task.dynamic) dispatchReadyDynamic();
      } catch (error) { ctx.ui.notify(errorText(error), "error"); }
    },
  });

  pi.registerTool({
    name: "CronCreate", label: "CronCreate", description: "在当前会话创建五字段本地时间 cron 提示词任务，默认循环；recurring=false 为单次提醒。每会话最多 50 个，循环七天过期。沿用当前工具权限；不会启动外部守护进程。",
    parameters: Type.Object({ cron: Type.String(), prompt: Type.String({ minLength: 1 }), recurring: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      adopt(ctx);
      if (disabled()) throw new Error("会话调度已关闭。");
      const task = scheduler.create({ schedule: params.cron, prompt: params.prompt, recurring: params.recurring });
      changed(); return result(describe(task));
    },
  });
  pi.registerTool({
    name: "CronList", label: "CronList", description: "列出当前会话调度任务的 8 字符 ID、计划、下次执行时间与提示词，包括动态循环待唤醒任务。", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { adopt(ctx); return result(scheduler.list().map(describe).join("\n") || "当前会话没有调度任务。"); },
  });
  pi.registerTool({
    name: "CronDelete", label: "CronDelete", description: "按 ID 取消当前会话任务的后续调度。不会中断正在执行的轮次。", parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      adopt(ctx); if (!scheduler.delete(params.id)) throw new Error(`找不到任务：${params.id}`);
      changed(); return result(`已取消任务 ${params.id}。`);
    },
  });
  pi.registerTool({
    name: "ScheduleWakeup", label: "ScheduleWakeup", description: "为动态 /loop 指定下轮延迟（60–3600 秒）和 reason；不指定则本轮结束后立即续跑。验收通过时传 stop:true。默认操作当前动态任务，其他动态任务指定 id。仅允许当前会话。",
    parameters: Type.Object({ id: Type.Optional(Type.String()), delaySeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })), reason: Type.Optional(Type.String()), stop: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, _signal, _update, ctx) {
      adopt(ctx);
      if (disabled() && !params.stop) throw new Error("会话调度已关闭。");
      const task = scheduler.wakeup(params); changed();
      return result(task ? `${describe(task)}\n延迟 ${params.delaySeconds} 秒；原因：${params.reason}` : "动态循环已停止。");
    },
  });

  pi.on("session_start", (event, ctx) => {
    stopTimer(); removeKeys?.(); removeKeys = undefined;
    context?.ui.setStatus?.("loop", undefined);
    generation++; scheduler.clear(); context = ctx; sessionId = identity(ctx);
    // Forks start fresh. Only fixed tasks in the selected session's own journal restore.
    if (event.reason !== "fork" && event.reason !== "new") {
      const entries = ctx.sessionManager.getEntries?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "custom" || entry.customType !== LOOP_ENTRY) continue;
        try {
          if (!isLoopSnapshot(entry.data)) throw new Error("调度快照格式无效。");
          scheduler.restore(entry.data, ctx.cwd);
        } catch (error) { ctx.ui.notify(`/loop 恢复失败：${errorText(error)}`, "error"); scheduler.clear(); }
        break;
      }
    }
    if (ctx.hasUI && ctx.ui.onTerminalInput) removeKeys = ctx.ui.onTerminalInput(data => {
      if ((data !== "\u001b" && data !== "\u0003") || !ctx.isIdle() || ctx.ui.getEditorText?.()) return undefined;
      if (!scheduler.cancelWaitingDynamic()) return undefined;
      changed(); ctx.ui.notify("已取消动态循环待唤醒任务。", "info");
      return { consume: true };
    });
    save(); arm();
  });
  pi.on("agent_settled", () => {
    if (scheduler.busy) { scheduler.settle(); changed(); }
    dispatchReadyDynamic();
  });
  pi.on("session_shutdown", () => {
    stopTimer(); removeKeys?.(); removeKeys = undefined;
    context?.ui.setStatus?.("loop", undefined);
    generation++; scheduler.clear(); context = undefined; sessionId = undefined;
  });
}
