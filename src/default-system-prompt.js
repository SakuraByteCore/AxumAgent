import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "./provider-config.js";

export const TODO_POLICY_BEGIN = "<!-- axum:todo-progress-policy v1 -->";
export const TODO_POLICY_END = "<!-- /axum:todo-progress-policy -->";

export const TODO_PROGRESS_POLICY = `${TODO_POLICY_BEGIN}
## Todo Progress Policy

The \`todo\` tool drives a live progress panel above the editor. The user watches
it while you work; a plan that is never created means a panel that never moves.

### Always maintain the plan

- For any multi-step task (3+ steps), call the \`todo\` tool with the full plan BEFORE starting the first step.
- Keep exactly one entry \`in_progress\`; the moment a step finishes, mark it \`completed\` and move the next step to \`in_progress\` in the same turn.
- Update the list whenever scope changes: add newly discovered work, drop obsolete steps, and never leave stale entries behind.

### Never

- Do not run a multi-step task with an empty or frozen plan on screen.
- Do not batch several finished steps into one overdue update; progress must be visible as it happens.
${TODO_POLICY_END}`;


export const PARALLEL_POLICY_BEGIN = "<!-- axum:parallel-tool-batching-policy v1 -->";
export const PARALLEL_POLICY_END = "<!-- /axum:parallel-tool-batching-policy -->";

export const PARALLEL_TOOL_BATCHING_POLICY = `${PARALLEL_POLICY_BEGIN}
## Parallel Tool Batching Policy

Pi executes all tool calls in one assistant message concurrently, so batching
independent calls cuts whole round-trips of latency. Serializing calls that
could be batched is wasted wall-clock time.

### Always batch in one message

- Independent reads, greps, globs, and listings across different files or directories.
- Independent web searches or fetches for different questions.
- Edits to unrelated files, once each target is confirmed.
- Independent commands that do not consume each other's output.

### Never batch

- A call whose arguments depend on a previous call's result.
- Multiple writes to the same file: run them one after another.
- A tool call that must observe the state left by an earlier call.
${PARALLEL_POLICY_END}`;
function buildUpsertedContent(existing, begin, end, block) {
  const start = existing.indexOf(begin);
  if (start !== -1) {
    const stop = existing.indexOf(end, start);
    if (stop !== -1) {
      return existing.slice(0, start) + block + existing.slice(stop + end.length);
    }
  }
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}
export function resolveAppendSystemPromptFile(env = process.env) {
  return path.join(getAgentDir(env), "APPEND_SYSTEM.md");
}

function ensureManagedPolicyBlock({ begin, end, block }, { env = process.env } = {}) {
  const target = resolveAppendSystemPromptFile(env);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const next = buildUpsertedContent(existing, begin, end, block);
  if (next === existing) return { path: target, changed: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next, { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return { path: target, changed: true };
}

export function ensureTodoProgressPolicy(options) {
  return ensureManagedPolicyBlock({ begin: TODO_POLICY_BEGIN, end: TODO_POLICY_END, block: TODO_PROGRESS_POLICY }, options);
}

export function ensureParallelToolBatchingPolicy(options) {
  return ensureManagedPolicyBlock({ begin: PARALLEL_POLICY_BEGIN, end: PARALLEL_POLICY_END, block: PARALLEL_TOOL_BATCHING_POLICY }, options);
}
