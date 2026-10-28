import { claudeDuplicateInput, claudeInitialized, claudeInputLifecycle } from "./input-lifecycle.js";
import { claudeServiceTierEvents } from "./service-tier.js";
import { claudeFailure, claudeLimitReset, claudeResultReason } from "./failure.js";
import { asNumber, asRecord } from "../../shared/json.js";
import { claudeContextCompacted, claudeContextSent, claudeContextUsage, initialClaudeContext } from "./context-usage.js";
import { foldModelUsage, freshModelUsage, resumedModelUsage, withBaseline, withMainLoop } from "./token-usage.js";
import { claudeTaskViews } from "./tasks.js";
import { claudeContent, claudeToolResults, contentBlocks } from "./content.js";
/** A new session's fold. */
export const initialClaudeProjection = {
    abortRequested: false,
    turnActive: false,
    nativeTurnActive: false,
    unclaimedInit: false,
    promptInputId: null,
    promptInputs: new Set(),
    unstartedInputs: new Set(),
    unacknowledgedInputs: new Set(),
    pendingInputId: null,
    agents: new Map(),
    tokens: new Map(),
    modelUsage: freshModelUsage,
    context: initialClaudeContext,
    partials: new Map(),
    taskDescriptions: new Map(),
    failureCategory: null,
    limitResetsAt: null,
};
/** A resumed session's fold: it counts no tokens until `claudeUsageBaselined` says where its share starts. */
export const resumedClaudeProjection = { ...initialClaudeProjection, modelUsage: resumedModelUsage };
/** The adapter's `get_usage` read-back at open: where a resumed Session's share of claude's running total starts. */
export function claudeUsageBaselined(state, baseline) {
    return { ...state, modelUsage: withBaseline(state.modelUsage, baseline) };
}
export { claudePrompted } from "./input-lifecycle.js";
export function claudeAbortRequested(state) {
    return { ...state, abortRequested: true };
}
function resultOutcome(state, message) {
    if (state.abortRequested) {
        return { kind: "aborted" };
    }
    if (message.is_error === true) {
        // Vendor quirk (pinned 2026-08-22): claude can report is_error=true with
        // subtype "success" and put the actual error text in result.
        const text = typeof message.result === "string" && message.result.length > 0
            ? message.result
            : undefined;
        const subtype = typeof message.subtype === "string" && message.subtype !== "success"
            ? message.subtype
            : undefined;
        return claudeFailure(text ?? claudeResultReason(subtype, message.errors), {
            category: state.failureCategory,
            status: asNumber(message.api_error_status),
            terminalReason: typeof message.terminal_reason === "string" ? message.terminal_reason : null,
            limitResetsAt: state.limitResetsAt,
            subtype: subtype ?? null,
        });
    }
    return { kind: "completed", ...(Object.hasOwn(message, "structured_output") ? { structuredOutput: message.structured_output } : {}) };
}
function pathKey(agentPath) {
    return JSON.stringify(agentPath);
}
/** The agent a frame belongs to: root, or the Task call that spawned it (nested through the call's own agent). */
function attributionOf(state, message) {
    const parent = message.parent_tool_use_id;
    if (typeof parent !== "string" || parent.length === 0) {
        return [];
    }
    return [...(state.agents.get(parent) ?? []), parent];
}
function rememberToolUses(state, message, agentPath) {
    const event = asRecord(message.event);
    const partial = event?.type === "content_block_start" ? asRecord(event.content_block) : null;
    const ids = (partial === null ? contentBlocks(message) : [partial])
        .filter((block) => block.type === "tool_use" && typeof block.id === "string")
        .map((block) => String(block.id));
    if (ids.length === 0) {
        return state;
    }
    const agents = new Map(state.agents);
    for (const id of ids) {
        agents.set(id, agentPath);
    }
    return { ...state, agents };
}
function frameType(message) {
    const type = typeof message.type === "string" ? message.type : "unknown";
    return typeof message.subtype === "string" ? `${type}/${message.subtype}` : type;
}
/**
 * Cumulative per-agent tokens after folding this result frame's own turn
 * usage: the main loop's (claude's word), so the root agent's. None while a
 * resumed Session's share is unknown. Subagents get no entry: only a
 * subagent's first assistant frame carries `parent_tool_use_id`, and its
 * `message.usage` is the stream-start value, not final ([env] 2.1.292), so
 * their spend stays in the session total, unattributed.
 */
function accumulate(state, agentPath, message) {
    const tokens = state.modelUsage.baseline.kind === "known" ? withMainLoop(state.tokens.get(pathKey(agentPath)), message) : null;
    if (tokens === null) {
        return null;
    }
    const next = new Map([...state.tokens, [pathKey(agentPath), tokens]]);
    return { state: { ...state, tokens: next }, tokens };
}
/** Fold one parsed claude stdout frame into the next state plus commands. */
export function foldClaudeStdout(state, message) {
    const type = frameType(message);
    const agentPath = attributionOf(state, message);
    const event = (body, next = state) => ({ state: next, commands: [{ kind: "frame", body: { type, native: message, ...body }, agentPath }] });
    switch (String(message.type)) {
        case "command_lifecycle": {
            const folded = claudeInputLifecycle(state, message, agentPath.length === 0);
            return event({ events: folded.events }, folded.state);
        }
        case "assistant":
        case "stream_event": {
            const content = claudeContent(state.partials, message, agentPath);
            const next = rememberToolUses({ ...state, partials: content.partials }, message, agentPath);
            if (message.type !== "assistant" || agentPath.length > 0) {
                return event({ events: content.events }, next);
            }
            // A root model call: the category of an error claude reports as an assistant message, and the context the call sent.
            return event({ events: content.events }, { ...next, failureCategory: typeof message.error === "string" ? message.error : next.failureCategory, context: claudeContextSent(next.context, message) });
        }
        case "user": {
            const views = [...claudeToolResults(message)];
            const body = asRecord(message.message);
            if (message.isReplay === true && typeof message.uuid === "string" && Array.isArray(body?.content)) {
                const input = body.content.map((part) => asRecord(part)).filter((part) => part?.type === "text").map((part) => typeof part?.text === "string" ? part.text : "").join("");
                views.push({ kind: "user_message", input, inputId: message.uuid, nativeMessageId: message.uuid, evidence: "acknowledged" });
            }
            const duplicate = message.isReplay === true && typeof message.uuid === "string"
                ? claudeDuplicateInput(state, message.uuid, agentPath.length === 0) : { state, events: [] };
            return event({ events: [...views, ...duplicate.events] }, duplicate.state);
        }
        case "result": {
            const events = [...claudeServiceTierEvents(message), { kind: "turn_ended", outcome: resultOutcome(state, message) }];
            const accumulated = accumulate(state, agentPath, message);
            const running = foldModelUsage(state.modelUsage, message);
            const { context, reading } = claudeContextUsage(state.context, message);
            if (accumulated !== null || context !== null || running.total !== null) {
                events.push({ kind: "usage", usage: {
                        ...(context === null ? {} : { context }),
                        ...(accumulated === null ? {} : { tokens: accumulated.tokens }),
                        ...(running.total === null ? {} : { total: running.total }),
                    } });
            }
            return event({ events }, { ...(accumulated?.state ?? state), modelUsage: running.usage, context: reading,
                ...(agentPath.length === 0 ? { turnActive: false, nativeTurnActive: false, unclaimedInit: false, ...(state.pendingInputId === null ? { promptInputId: null } : {}) } : {}), abortRequested: false, failureCategory: null });
        }
        case "system": {
            if (message.subtype === "compact_boundary") {
                // claude reports compaction only after the fact: the boundary frame
                // carries compact_metadata {trigger: manual | auto, pre_tokens, …}
                // ([sym] 2.1.272); there is no start frame, so no compaction_started.
                const trigger = asRecord(message.compact_metadata)?.trigger;
                return event({ events: [{ kind: "compaction_ended", outcome: "completed", ...(typeof trigger === "string" ? { trigger } : {}) }] }, agentPath.length === 0 ? { ...state, context: claudeContextCompacted(state.context) } : state);
            }
            if (message.subtype === "init") {
                const initialized = claudeInitialized(state, agentPath.length === 0);
                return event({ events: [...initialized.events,
                        ...(typeof message.model === "string" ? [{ kind: "model", model: message.model }] : []),
                        ...claudeServiceTierEvents(message)] }, initialized.state);
            }
            const task = claudeTaskViews(message, state.taskDescriptions, agentPath);
            return event({ events: [...task.events, ...claudeServiceTierEvents(message)] }, task.descriptions === state.taskDescriptions ? state : { ...state, taskDescriptions: task.descriptions });
        }
        case "control_response": {
            // claude answering one of OUR control_requests (interrupt): the frame IS
            // the response record (native verbatim); one frame, one record, so it
            // is not also recorded as an event. A control_response we cannot pair
            // is recorded as a plain event.
            const response = asRecord(message.response);
            const requestId = typeof response?.request_id === "string" ? response.request_id : null;
            if (requestId === null) {
                return event({ events: [] });
            }
            const error = typeof response?.error === "string" ? response.error : null;
            return { state, commands: [{
                        kind: "respond",
                        requestId,
                        body: response?.subtype === "error" || error !== null
                            ? { kind: "rejected", code: "runtime_refused", reason: error ?? "control request failed", native: message }
                            : { kind: "accepted", native: message },
                    }] };
        }
        case "control_request": {
            // claude asks the app something (permission, question). Recorded verbatim; the adapter answers nothing.
            const id = typeof message.request_id === "string" ? message.request_id : `claude-${String(Date.now())}`;
            const request = asRecord(message.request);
            const subtype = typeof request?.subtype === "string" ? request.subtype : "control_request";
            return {
                state,
                commands: [
                    { kind: "frame", body: { type, native: message, events: [] }, agentPath },
                    { kind: "toApp", id, type: subtype, native: message },
                ],
            };
        }
        case "rate_limit_event":
            // claude's view of the subscription limits changed: read for a failed turn's resetsAt, no event of its own.
            return event({ events: [] }, { ...state, limitResetsAt: claudeLimitReset(asRecord(message.rate_limit_info)) });
        case "control_cancel_request":
            // claude withdrew a request it had sent us (an interrupt cancels a pending question).
            return event({ events: typeof message.request_id === "string" ? [{ kind: "app_request_cancelled", requestId: message.request_id }] : [] });
        default:
            return event({ events: [] });
    }
}
