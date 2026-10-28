import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { AgentSession } from "./shared.js";

/** Reuse the exact companion guard loaded by the main Axum session. */
export function childRecoveryExtensions(options: {
	noExtensions?: boolean;
	extensions?: string[];
}): string[] {
	const extensions = options.extensions ?? [];
	if (options.noExtensions) return extensions;
	const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const companion = fileURLToPath(new URL(`../pi-companion/index.${suffix}`, import.meta.url));
	const companionDirectory = path.dirname(companion);
	const alreadyLoaded = extensions.some((entry) =>
		entry === companionDirectory || (path.dirname(entry) === companionDirectory && /^index\.(ts|js)$/.test(path.basename(entry))),
	);
	return alreadyLoaded ? extensions : [...extensions, companion];
}

/** Guard follow-ups can outlive the initial prompt; do not deliver intermediate errors. */
export async function promptChildUntilSettled(session: AgentSession, instruction: string): Promise<void> {
	await session.prompt(instruction);
	await session.waitForIdle();
}

/** Loader-free execution deadline controller. Waiting/collection timeouts must not call this. */
export type DispatchDeadlineState = {
 status: string; aborted?: boolean; completedAt?: number; error?: string;
 timeoutMs?: number; deadlineAt?: number; stopCause?: "deadline";
 cancelDeadline?: () => void;
 session?: { isStreaming?: boolean; abort: () => unknown; steer: (text: string) => unknown };
 finished: Promise<void>;
};

export class DispatchDeadlineError extends Error {
 constructor() { super("Dispatch execution deadline reached"); this.name = "DispatchDeadlineError"; }
}

export function armExecutionDeadline(
 agent: DispatchDeadlineState, timeoutMs: number, deadlineAt = Date.now() + timeoutMs,
 onError: (event: string, error: unknown) => void = () => {},
): () => void {
 agent.cancelDeadline?.();
 agent.deadlineAt = deadlineAt;
 let cancelled = false;
 const live = () => !cancelled && !agent.aborted && agent.completedAt === undefined &&
  !agent.error && !["error", "posted", "idle", "done-waiting-to-post"].includes(agent.status);
 const safely = (event: string, action: () => unknown) => {
  try { void Promise.resolve(action()).catch(error => onError(event, error)); }
  catch (error) { onError(event, error); }
 };
 const reserve = Math.min(30_000, Math.floor(timeoutMs * 0.2));
 const checkpoint = setTimeout(() => {
  if (!live() || !agent.session?.isStreaming) return;
  safely("deadline-checkpoint-failed", () => agent.session!.steer(
   `Dispatch deadline approaching: ${reserve}ms remain. Stop starting new work or tools. Save completed changes and return a concise final handoff now: status, changed files, checks, remaining risks. This does not extend the deadline.`
  ));
 }, Math.max(0, deadlineAt - Date.now() - reserve));
 const timer = setTimeout(() => {
  if (!live()) return;
  agent.timeoutMs = timeoutMs;
  agent.stopCause = "deadline";
  // Session creation can finish later. The runner must check stopCause before prompting.
  if (agent.session) safely("deadline-abort-failed", () => agent.session!.abort());
 }, Math.max(0, deadlineAt - Date.now()));
 const cancel = () => {
  cancelled = true; clearTimeout(checkpoint); clearTimeout(timer);
  if (agent.cancelDeadline === cancel) agent.cancelDeadline = undefined;
 };
 agent.cancelDeadline = cancel;
 void agent.finished.then(cancel, cancel);
 return cancel;
}

/** Call after session creation and before every prompt/recovery turn. */
export function throwIfDispatchDeadline(agent: Pick<DispatchDeadlineState, "stopCause" | "deadlineAt" | "timeoutMs">): void {
 if (agent.stopCause === "deadline" || (agent.deadlineAt !== undefined && Date.now() >= agent.deadlineAt)) {
  agent.stopCause = "deadline";
  throw new DispatchDeadlineError();
 }
}
