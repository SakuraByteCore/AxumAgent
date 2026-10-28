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


export const SUBAGENT_POLICY_END = "<!-- /axum:subagent-delegation-policy -->";
const LEGACY_SUBAGENT_POLICY_PAIRS = [
  ["<!-- axum:subagent-delegation-policy v5 -->", SUBAGENT_POLICY_END],
  ["<!-- axum:subagent-delegation-policy v4 -->", SUBAGENT_POLICY_END],
  ["<!-- axum:subagent-delegation-policy v3 -->", SUBAGENT_POLICY_END],
  ["<!-- axum:subagent-delegation-policy v1 -->", SUBAGENT_POLICY_END],
  ["<!-- axum:subagent-delegation-policy v2 -->", SUBAGENT_POLICY_END],
];
export const SUBAGENT_POLICY_BEGIN = "<!-- axum:subagent-delegation-policy v6 -->";

export const SUBAGENT_DELEGATION_POLICY = `${SUBAGENT_POLICY_BEGIN}
## Subagent Delegation Policy

Own the user goal through implementation, verification and synthesis. Use only
dispatch_agent to create children; pi-subagents, subagent_supervisor and
legacy worker aliases are disabled. Actively batch worthwhile independent lanes
with exclusive writeScope and acceptance checks in each full task package. Do not require
the user to manually split tasks. Trivial or indivisible work stays inline;
dependent work waits for prerequisite evidence. No fixed lane count or relay.

Keep the parent productive on the critical path. Respect parent permissions,
approvals and owned-file coordination; children never recursively dispatch.
Children run one self-contained task in an independent context. Package the full
goal, necessary context, owned files, interfaces and acceptance checks.
Use manage_agent only for status, wait, interrupt and close. No send/resume/rebase.
For new requirements inspect current results and dispatch a new incremental task;
never automatically repeat side effects. Default real OAR Codex uses isolated
snapshots, mandatory container isolation and Codex sandbox, with scoped conflict-
checked diff integration. Native tools do not inherit the parent approval bridge;
writeScope authorizes snapshot edits and integration. Missing prerequisites fail
closed without Pi fallback. Put tests in task (testCommands is controlled-pi only).
controlled-pi is explicit compatibility; oar-claude-text is explicit text-only.
Wait timeouts do not cancel children. Do not invent execution deadlines; /quick
has no implicit budget. Inspect actual diffs and checks before integrating each
result; report partial work honestly and never forward raw agent dumps.
${SUBAGENT_POLICY_END}`;

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

export const FOCUS_POLICY_BEGIN = "<!-- axum:focus-execution-policy v1 -->";
export const FOCUS_POLICY_END = "<!-- /axum:focus-execution-policy -->";

export const FOCUS_EXECUTION_POLICY = `${FOCUS_POLICY_BEGIN}
## Focus Execution Policy

Spend turns and tokens on decisions, actions, and inspectable results — not on
performing the process. Narration that restates work carries no information value.

### Never

- Opening pleasantries or restating the user's request before acting.
- Announcing what you are about to do ("Now I will...", "Let me check...").
- Repeating tool arguments, file contents, or command output back in prose.
- Ceremonial post-action summaries that add nothing beyond the tool result.
- Asking permission to continue mid-task; proceed and report at completion.

### Always

- Lead with the decision or the result; keep prose to what changes the user's next action.
- Let tool calls and their outputs be the execution record; never duplicate them in prose.
- Surface failures and blockers immediately, with evidence and the recovery path.
- Answer direct questions fully — analysis and explanations are deliverables, not theater.

### Progress

- When the \`todo\` tool is available, progress lives on the panel, not in prose.
- Without it, a single short progress line per turn is allowed; never a narrative.
${FOCUS_POLICY_END}`;
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

export function ensureFocusExecutionPolicy(options) {
  return ensureManagedPolicyBlock({ begin: FOCUS_POLICY_BEGIN, end: FOCUS_POLICY_END, block: FOCUS_EXECUTION_POLICY }, options);
}

export function ensureSubagentDelegationPolicy({ env = process.env } = {}) {
  const target = resolveAppendSystemPromptFile(env);
  const original = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  let existing = original;
  for (const [legacyBegin, legacyEnd] of LEGACY_SUBAGENT_POLICY_PAIRS) {
    const legacyStart = existing.indexOf(legacyBegin);
    if (legacyStart === -1) continue;
    const legacyStop = existing.indexOf(legacyEnd, legacyStart);
    if (legacyStop === -1) continue;
    existing = legacyStart === 0
      ? existing.slice(legacyStop + legacyEnd.length).trimStart()
      : (existing.slice(0, legacyStart) + existing.slice(legacyStop + legacyEnd.length)).replace(/\n{3,}/g, "\n\n");
  }
  const next = buildUpsertedContent(existing, SUBAGENT_POLICY_BEGIN, SUBAGENT_POLICY_END, SUBAGENT_DELEGATION_POLICY);
  if (next === original) return { path: target, changed: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next, { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return { path: target, changed: true };
}
