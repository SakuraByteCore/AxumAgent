// Shared one-shot lifecycle contract for the bundled controlled SDK.
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
