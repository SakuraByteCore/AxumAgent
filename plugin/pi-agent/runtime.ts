// SPDX-License-Identifier: Apache-2.0
// Independent structural adapter; no implementation copied from upstream harness.
import { randomUUID } from 'node:crypto';

export type StopReason = 'completed' | 'aborted' | 'timeout' | 'error';
export interface RuntimeRequest { task: string; cwd: string; signal: AbortSignal; timeoutMs?: number }
export interface RuntimeDiagnostic { stage: 'installation' | 'startup' | 'turn' | 'abort' | 'dispose' | 'events'; message: string }
export interface RuntimeResult {
 text: string;
 stopReason: StopReason;
 partial: boolean;
 diagnostics: readonly RuntimeDiagnostic[];
 cleanupFailure?: RuntimeDiagnostic;
}
export interface RunHandle {
 readonly result: Promise<RuntimeResult>;
 /** Observation only: expiry never cancels execution. */
 wait(timeoutMs?: number): Promise<RuntimeResult | undefined>;
 cancel(): Promise<void>;
 dispose(): Promise<void>;
}
export interface Runtime { start(request: RuntimeRequest): RunHandle }
export interface OarEvent { sessionId: string; agentPath: readonly unknown[]; kind: string; text?: string; messageId?: string }
export interface OarSession {
 readonly id: string;
 events(listener: (event: OarEvent) => void, options: { cursor: { sessionId: string; afterSeq: number } }): () => void;
 prompt(text: string, options: { inputId: string }): Promise<{ kind: 'accepted'; seq: number } | { kind: 'rejected'; code: string }>;
 abort(): Promise<void>;
 dispose(): Promise<void>;
}
export interface OarInstallation { kind: string }
export interface OarOptions { model?: string; effort?: string; env?: Readonly<Record<string, string | null>>; launchArgs?: readonly string[] }
export interface OarRuntime {
 installation?(options: { env: Readonly<Record<string, string | null>> }): Promise<OarInstallation>;
 session(installation: OarInstallation, options: OarOptions & { cwd: string }): Promise<OarSession>;
}
export type OarTurnOutcome = { kind: 'completed' | 'aborted' } | { kind: 'failed'; failure: string };
export type AwaitTurnEnd = (session: OarSession, afterSeq: number, inputId: string) => Promise<OarTurnOutcome>;

function validTimeout(value: number | undefined): void {
 if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2147483647)) throw new Error('timeoutMs must be a positive timer-safe number');
}
/** Options are deployment-owned, snapshotted, and never merged from task input.
 * Explicit timeout includes startup. Cancellation result waits for owned cleanup;
 * an uninterruptible native startup must return before late-session disposal.
 * Error messages intentionally omit native causes (which may contain secrets).
 */
export function createOarRuntime(native: OarRuntime, awaitTurnEnd: AwaitTurnEnd, options: OarOptions = {}): Runtime {
 const fixed = Object.freeze({
  ...(options.model === undefined ? {} : { model: options.model }),
  ...(options.effort === undefined ? {} : { effort: options.effort }),
  env: Object.freeze({ ...options.env }), launchArgs: Object.freeze([...(options.launchArgs ?? [])]),
 });
 return { start(request) {
  if (!request.task.trim() || !request.cwd.trim()) throw new Error('task and cwd are required');
  validTimeout(request.timeoutMs);
  // Copy the request to prevent caller mutation while startup is pending.
  const { task, cwd, signal, timeoutMs } = request;
  const diagnostics: RuntimeDiagnostic[] = [];
  let session: OarSession | undefined, disposal: Promise<void> | undefined, abortion: Promise<void> | undefined;
  let cleanupFailure: RuntimeDiagnostic | undefined;
  let stopped: StopReason | undefined, finished = false, acceptingEvents = true;
  let fallback = '';
  const messages = new Map<string, string>();
  const answer = () => [...messages.values()].filter(Boolean).at(-1) ?? fallback;
  let release!: () => void;
  const interrupted = new Promise<void>(resolve => { release = resolve; });
  const diagnostic = (stage: RuntimeDiagnostic['stage']) => {
   const entry = { stage, message: 'OAR ' + stage + ' failed' };
   diagnostics.push(entry); return entry;
  };
  const cleanup = (): Promise<void> => {
   if (!session) return Promise.resolve();
   return disposal ??= Promise.resolve().then(() => session!.dispose()).catch(() => { cleanupFailure = diagnostic('dispose'); });
  };
  const abort = (): Promise<void> => {
   if (!session) return Promise.resolve();
   return abortion ??= Promise.resolve().then(() => session!.abort()).catch(() => { diagnostic('abort'); });
  };
  const stop = (reason: StopReason): void => {
   if (finished || stopped) return;
   stopped = reason; acceptingEvents = false; release();
   // Disposal is not blocked by an abort implementation that never resolves.
   void abort(); void cleanup();
  };
  const onAbort = () => stop('aborted');
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop('timeout'), timeoutMs);
  const result = (async (): Promise<RuntimeResult> => {
   let reason: StopReason = 'error';
   let stage: RuntimeDiagnostic['stage'] = 'installation';
   let unsubscribe: (() => void) | undefined;
   try {
    if (!stopped) {
     const installation = await native.installation?.({ env: fixed.env });
     if (!stopped) {
      if (!installation || installation.kind === 'unsupported' || installation.kind === 'not_found') throw new Error('unavailable');
      stage = 'startup';
      session = await native.session(installation, { ...fixed, cwd });
      if (!stopped) {
       unsubscribe = session.events(event => {
        if (!acceptingEvents || event.sessionId !== session!.id || event.agentPath.length || event.kind !== 'text_delta' || typeof event.text !== 'string') return;
        fallback += event.text;
        if (event.messageId !== undefined) messages.set(event.messageId, (messages.get(event.messageId) ?? '') + event.text);
       }, { cursor: { sessionId: session.id, afterSeq: -1 } });
       stage = 'turn';
       const turn = async (): Promise<StopReason> => {
        if (stopped) return stopped;
        const inputId = randomUUID();
        const admission = await session!.prompt(task, { inputId });
        if (stopped) return stopped;
        if (admission.kind === 'rejected') { diagnostic('turn'); return 'error'; }
        const outcome = await awaitTurnEnd(session!, admission.seq, inputId);
        if (outcome.kind === 'failed') { diagnostic('turn'); return 'error'; }
        return outcome.kind === 'completed' ? 'completed' : 'aborted';
       };
       // race observes late native rejection; no retry or second prompt.
       reason = await Promise.race([turn(), interrupted.then(() => stopped!)]);
      }
     }
    }
   } catch { diagnostic(stage); }
   finally {
    // Execution is terminal before cleanup: late cancel must not replace success
    // or issue a redundant native abort while disposal is pending.
    finished = true;
    acceptingEvents = false;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    try { unsubscribe?.(); } catch { diagnostic('events'); }
    if (stopped && session) void abort();
    await cleanup();
    finished = true;
   }
   const stopReason = stopped ?? reason;
   return { text: answer(), stopReason, partial: stopReason !== 'completed', diagnostics: [...diagnostics], ...(cleanupFailure ? { cleanupFailure } : {}) };
  })();
  return {
   result,
   wait(ms) {
    validTimeout(ms);
    if (ms === undefined) return result;
    return new Promise(resolve => {
     const timer = setTimeout(() => resolve(undefined), ms);
     void result.then(value => { clearTimeout(timer); resolve(value); });
    });
   },
   cancel() { stop('aborted'); return result.then(() => undefined); },
   dispose() { stop('aborted'); return result.then(() => undefined); },
  };
 } };
}
