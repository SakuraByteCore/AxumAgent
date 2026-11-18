import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { runCommandHooks, type HookEvent, type HookResult, type JsonObject } from "./command-hooks.ts";

function json(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value));
}
export function registerCommandHooks(pi: ExtensionAPI): void {
  let sessionContext: string[] = [];
  const toolContext = new Map<string, string[]>();
  let stopHookActive = false;
  const run = async (ctx: ExtensionContext, options: { event: HookEvent; fields?: JsonObject; matchNames?: string[]; signal?: AbortSignal }): Promise<HookResult> => {
    const result = await runCommandHooks({
      ...options, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId?.() ?? "",
      transcriptPath: ctx.sessionManager?.getSessionFile?.(), trusted: ctx.isProjectTrusted?.() === true,
      signal: options.signal ?? ctx.signal,
    });
    for (const warning of result.warnings) ctx.ui.notify(`[Hooks:${options.event}] ${warning}`, "warning");
    return result;
  };
  pi.on("session_start", async (event, ctx) => {
    sessionContext = []; toolContext.clear(); stopHookActive = false;
    const source = event.reason === "startup" ? "startup" : event.reason === "resume" ? "resume" : event.reason;
    const result = await run(ctx, { event: "SessionStart", fields: { source }, matchNames: [source] });
    sessionContext.push(...result.context);
  });
  pi.on("input", async (event, ctx) => {
    stopHookActive = false;
    const result = await run(ctx, { event: "UserPromptSubmit", fields: { prompt: event.text, source: event.source } });
    if (result.blocked) { ctx.ui.notify(`[Hooks] ${result.reason}`, "warning"); return { action: "handled" }; }
    sessionContext.push(...result.context);
  });
  pi.on("before_agent_start", () => {
    if (!sessionContext.length) return;
    const content = sessionContext.join("\n\n");
    sessionContext = [];
    return { message: { customType: "command-hooks", content, display: false } };
  });
  pi.on("tool_call", async (event, ctx) => {
    const result = await run(ctx, { event: "PreToolUse", fields: { tool_name: event.toolName, tool_input: json(event.input), tool_use_id: event.toolCallId } });
    if (result.blocked) return { block: true, reason: result.reason };
    if (result.updatedInput) {
      const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
      if (!tool) return { block: true, reason: "Hook updated an unavailable tool" };
      const validated = validateToolArguments(tool, { type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: result.updatedInput });
      for (const key of Object.keys(event.input)) Reflect.deleteProperty(event.input, key);
      Object.assign(event.input, validated);
    }
    if (result.context.length) toolContext.set(event.toolCallId, result.context);
  });
  pi.on("tool_result", async (event, ctx) => {
    const hookEvent = event.isError ? "PostToolUseFailure" : "PostToolUse";
    const result = await run(ctx, { event: hookEvent, fields: {
      tool_name: event.toolName, tool_input: json(event.input), tool_use_id: event.toolCallId,
      tool_response: json({ content: event.content, details: event.details, isError: event.isError }),
    } });
    const context = [...(toolContext.get(event.toolCallId) ?? []), ...result.context];
    toolContext.delete(event.toolCallId);
    if (!context.length) return;
    return {
      content: [...event.content, { type: "text", text: context.join("\n\n") }],
      structuredContent: event.structuredContent,
    };
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || event.continue) return;
    const active = stopHookActive;
    const lastAssistant = event.context.llmMessages.filter((message) => message.role === "assistant").at(-1);
    const lastText = lastAssistant?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    const result = await run(ctx, { event: "Stop", fields: { stop_hook_active: active, last_assistant_message: lastText } });
    if (!result.blocked) return;
    if (active) { ctx.ui.notify("[Hooks] Stop hook continuation limit reached", "warning"); return; }
    stopHookActive = true;
    return { continue: true, entries: [{ type: "custom_message", customType: "command-hooks-stop", content: result.reason, display: false }] };
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const trigger = event.reason === "manual" ? "manual" : "auto";
    const result = await run(ctx, { event: "PreCompact", fields: { trigger, custom_instructions: event.customInstructions ?? "" }, matchNames: [trigger], signal: event.signal });
    if (result.blocked) { ctx.ui.notify(`[Hooks] ${result.reason}`, "warning"); return { cancel: true }; }
  });
  pi.on("session_compact", async (event, ctx) => {
    const trigger = event.reason === "manual" ? "manual" : "auto";
    await run(ctx, { event: "PostCompact", fields: { trigger }, matchNames: [trigger] });
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await run(ctx, { event: "SessionEnd", fields: { reason: event.reason }, matchNames: [event.reason] });
    sessionContext = []; toolContext.clear(); stopHookActive = false;
  });
}
