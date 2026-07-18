export type AxumSubmissionOp = "user_input" | "tool_output" | "cancel";
export type AxumChildTaskStatus = "planned" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AxumEventKind =
  | "session_configured"
  | "turn_started"
  | "context_captured"
  | "child_task_planned"
  | "child_task_queued"
  | "child_task_started"
  | "child_task_completed"
  | "child_task_failed"
  | "child_task_cancelled"
  | "merge_review_started"
  | "merge_review_completed"
  | "model_sampling_started"
  | "provider_warning"
  | "assistant_message_delta"
  | "assistant_message"
  | "tool_call_requested"
  | "tool_call_completed"
  | "permission_denied"
  | "turn_completed"
  | "turn_failed";

export interface AxumSubmission<T = unknown> {
  id: string;
  op: AxumSubmissionOp;
  payload: T;
  createdAt: string;
}

export interface AxumEvent<T = unknown> {
  id: number;
  turnId?: string;
  kind: AxumEventKind;
  payload: T;
  createdAt: string;
}

export interface AxumPlanItem {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AxumUpdatePlanArgs {
  explanation?: string;
  plan: AxumPlanItem[];
}

export interface AxumRuntimeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AxumRuntimeToolOutput {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
}

export interface AxumChildTask {
  id: string;
  prompt: string;
  mode: string;
  status: AxumChildTaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  error?: string;
}

export interface AxumMergeReview {
  status: "pending" | "running" | "accepted" | "changes_requested" | "failed";
  policy: "hash-anchor-review";
  taskIds: string[];
  summary?: string;
}

export interface AxumTurnResult {
  turnId: string;
  assistantMessage: string;
  toolOutputs: AxumRuntimeToolOutput[];
  events: AxumEvent[];
}

export function createSubmission<T>(op: AxumSubmissionOp, payload: T): AxumSubmission<T> {
  return {
    id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    op,
    payload,
    createdAt: new Date().toISOString(),
  };
}
