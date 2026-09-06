import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "./provider-config.js";

export const SUBAGENT_POLICY_BEGIN = "<!-- axum:subagent-delegation-policy v1 -->";
export const SUBAGENT_POLICY_END = "<!-- /axum:subagent-delegation-policy -->";

export const SUBAGENT_DELEGATION_POLICY = `${SUBAGENT_POLICY_BEGIN}
## Subagent Delegation Policy

Whenever delegating saves wall-clock time without risking correctness, prefer the \`Agent\` tool over doing the work inline. The main thread keeps only decision-making, scoping, and aggregation.

### Always delegate

- Independent exploration, investigation, or review (multi-file reads, cross-module searches, external research): split into non-overlapping scopes and fan out in parallel with \`run_in_background\`.
- Long-running operations (builds, full test suites, dependency installs, network fetches): run in the background and keep the main thread moving until the completion notice arrives.
- Bulk homogeneous edits across unrelated files or modules: assign each subagent one group; the main thread performs final acceptance.

### Never delegate

- Trivial single-step operations (one read, one grep, one tiny edit) where delegation overhead exceeds the work itself.
- Steps with data dependencies on each other (sequential chains stay inline).
- Multiple writers targeting the same file: merge them into a single subagent to prevent write conflicts.

### Execution rules

- Default to \`run_in_background: true\`; block only when the next step strictly depends on the result.
- Every dispatch must state: role, exact scope, allowed write boundaries, and expected report granularity.
- After subagent reports arrive, the main thread validates conflicts and synthesizes; never forward raw multi-agent reports to the user.
${SUBAGENT_POLICY_END}`;

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

export function ensureSubagentDelegationPolicy(options) {
  return ensureManagedPolicyBlock({ begin: SUBAGENT_POLICY_BEGIN, end: SUBAGENT_POLICY_END, block: SUBAGENT_DELEGATION_POLICY }, options);
}

export function ensureTodoProgressPolicy(options) {
  return ensureManagedPolicyBlock({ begin: TODO_POLICY_BEGIN, end: TODO_POLICY_END, block: TODO_PROGRESS_POLICY }, options);
}
