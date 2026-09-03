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

function buildUpsertedContent(existing, block) {
  const begin = existing.indexOf(SUBAGENT_POLICY_BEGIN);
  if (begin !== -1) {
    const end = existing.indexOf(SUBAGENT_POLICY_END, begin);
    if (end !== -1) {
      return existing.slice(0, begin) + block + existing.slice(end + SUBAGENT_POLICY_END.length);
    }
  }
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

export function resolveAppendSystemPromptFile(env = process.env) {
  return path.join(getAgentDir(env), "APPEND_SYSTEM.md");
}

export function ensureSubagentDelegationPolicy({ env = process.env } = {}) {
  const target = resolveAppendSystemPromptFile(env);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const next = buildUpsertedContent(existing, SUBAGENT_DELEGATION_POLICY);
  if (next === existing) return { path: target, changed: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next, { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return { path: target, changed: true };
}
