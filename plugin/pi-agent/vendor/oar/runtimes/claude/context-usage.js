import { asNumber, asRecord } from "../../shared/json.js";
export const initialClaudeContext = { kind: "unchanged", model: null };
/** claude's model for the messages it makes up itself (an interrupted or errored turn's reply): no model call. */
const SYNTHETIC_MODEL = "<synthetic>";
/** A root `assistant` frame: the context its model call sent. Every frame of one message repeats the same usage. */
export function claudeContextSent(reading, message) {
    const body = asRecord(message.message);
    const usage = asRecord(body?.usage);
    const model = typeof body?.model === "string" ? body.model : null;
    if (usage === null || model === SYNTHETIC_MODEL) {
        return reading;
    }
    const tokens = (asNumber(usage.input_tokens) ?? 0) + (asNumber(usage.cache_read_input_tokens) ?? 0) + (asNumber(usage.cache_creation_input_tokens) ?? 0);
    return { kind: "sent", tokens, model: model ?? reading.model };
}
/** A root `compact_boundary`: what the context holds is unknown until claude's next call. */
export function claudeContextCompacted(reading) {
    return { kind: "compacted", model: reading.model };
}
function windowOf(result, model) {
    const modelUsage = asRecord(result.modelUsage);
    if (modelUsage === null) {
        return null;
    }
    const entry = asRecord((model === null ? undefined : modelUsage[model]) ?? Object.values(modelUsage)[0]);
    return entry === null ? null : asNumber(entry.contextWindow);
}
/** A root `result`: the turn's context reading, null when nothing changed it; the reading starts over for the next turn. */
export function claudeContextUsage(reading, result) {
    const next = { kind: "unchanged", model: reading.model };
    if (reading.kind === "unchanged") {
        return { context: null, reading: next };
    }
    const contextWindow = windowOf(result, reading.model);
    const tokens = reading.kind === "sent" ? reading.tokens : null;
    const percent = tokens === null || contextWindow === null || contextWindow === 0 ? null : Math.round((tokens / contextWindow) * 100);
    return { context: { tokens, contextWindow, percent }, reading: next };
}
