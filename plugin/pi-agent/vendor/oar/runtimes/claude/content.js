import { toolContent } from "../../shared/tool-output.js";
import { asRecord } from "../../shared/json.js";
export function contentBlocks(message) {
    const content = asRecord(message.message)?.content;
    return Array.isArray(content) ? content.map((block) => asRecord(block)).filter((block) => block !== null) : [];
}
function textEvent(type, text, id) {
    const identity = id === undefined ? {} : { messageId: id };
    return type === "text"
        ? { kind: "text_delta", text, ...identity }
        : { kind: "reasoning", content: { kind: "text", text }, ...identity };
}
/** Keep only a tool's identity: argument fragments are emitted, never parsed or accumulated here. */
function streamContent(previous, event) {
    if (event.type === "message_start") {
        const id = asRecord(event.message)?.id;
        return { message: { ...(typeof id === "string" ? { id } : {}), blocks: new Map() }, events: [] };
    }
    const message = previous ?? { blocks: new Map() };
    const body = event.type === "content_block_start" ? asRecord(event.content_block)
        : (event.type === "content_block_delta" ? asRecord(event.delta) : null);
    if (typeof event.index !== "number") {
        return { message: previous, events: [] };
    }
    const blocks = new Map(message.blocks);
    if (body?.type === "tool_use" && typeof body.id === "string" && typeof body.name === "string") {
        const prior = blocks.get(event.index);
        blocks.set(event.index, { type: "tool_use", callId: body.id });
        return { message: { ...message, blocks }, events: prior?.type === "tool_use" && prior.callId === body.id ? [] : [{ kind: "tool_call_started", callId: body.id, tool: body.name }] };
    }
    if (body?.type === "input_json_delta" && typeof body.partial_json === "string") {
        const tool = blocks.get(event.index);
        return { message: previous, events: tool?.type === "tool_use" ? [{ kind: "tool_call_input_delta", callId: tool.callId, delta: body.partial_json }] : [] };
    }
    const type = body?.type === "text" || body?.type === "text_delta" ? "text"
        : (body?.type === "thinking" || body?.type === "thinking_delta" ? "thinking" : null);
    if (type === null) {
        return { message: previous, events: [] };
    }
    const value = body?.[type];
    const text = typeof value === "string" ? value : "";
    const prior = event.type === "content_block_start" ? undefined : blocks.get(event.index);
    blocks.set(event.index, { type, text: (prior?.type === type ? prior.text : "") + text, finalized: false });
    return { message: { ...message, blocks }, events: text.length === 0 ? [] : [textEvent(type, text, message.id)] };
}
/** Native 2.1.293 emits one completed block just before its content_block_stop,
 * with the same API id for every block. Consume that block's streamed prefix
 * once, rather than treating an entire message id as already projected. */
function finalContent(message, partial) {
    const id = asRecord(message.message)?.id;
    const identity = typeof id === "string" ? { messageId: id } : {};
    const blocks = new Map(partial?.blocks);
    const remainder = (type, full) => {
        if (typeof id !== "string" || partial?.id !== id) {
            return full;
        }
        const pending = [...blocks].find((entry) => entry[1].type === type && !entry[1].finalized);
        if (pending === undefined) {
            return full;
        }
        const [index, block] = pending;
        blocks.set(index, { ...block, finalized: true });
        if (block.text.length === 0 || !full.startsWith(block.text)) {
            return full;
        }
        const suffix = full.slice(block.text.length);
        return suffix.length === 0 ? null : suffix;
    };
    const events = [];
    for (const block of contentBlocks(message)) {
        switch (block.type) {
            case "text": {
                const text = typeof block.text === "string" ? remainder("text", block.text) : null;
                if (text !== null) {
                    events.push({ kind: "text_delta", text, ...identity });
                }
                break;
            }
            case "thinking": {
                const text = remainder("thinking", typeof block.thinking === "string" ? block.thinking : "");
                if (text !== null) {
                    events.push({ kind: "reasoning", content: text.length > 0 ? { kind: "text", text } : { kind: "empty" }, ...identity });
                }
                break;
            }
            case "redacted_thinking":
                events.push({ kind: "reasoning", content: { kind: "redacted" }, ...identity });
                break;
            case "tool_use": {
                // A streamed start already announced this call. The completed block
                // replaces its input, even before content_block_stop (native order).
                const started = (partial?.id === id || partial?.id === undefined) && [...blocks.values()].some((item) => item.type === "tool_use" && item.callId === block.id);
                if (started) {
                    if (block.input !== undefined) {
                        events.push({ kind: "tool_call_input", callId: String(block.id), input: JSON.stringify(block.input) });
                    }
                    break;
                }
                events.push({
                    kind: "tool_call_started",
                    callId: typeof block.id === "string" ? block.id : "unknown",
                    tool: typeof block.name === "string" ? block.name : "unknown",
                    ...(block.input === undefined ? {} : { input: JSON.stringify(block.input) }),
                });
                break;
            }
            default:
                break;
        }
    }
    return { message: partial === undefined ? undefined : { ...partial, blocks }, events };
}
/** Pure content projection; the caller records the original frame even if events is empty. */
export function claudeContent(partials, message, agentPath) {
    const lane = JSON.stringify(agentPath);
    if (message.type === "stream_event" && asRecord(message.event)?.type === "message_stop") {
        // Every completed assistant block precedes this native boundary. Only
        // this agent is done; other agents may still have partial output pending.
        const remaining = new Map(partials);
        remaining.delete(lane);
        return { partials: remaining, events: [] };
    }
    const previous = partials.get(lane);
    const next = message.type === "stream_event"
        ? streamContent(previous, asRecord(message.event) ?? {})
        : finalContent(message, previous);
    return { partials: next.message === undefined ? partials : new Map([...partials, [lane, next.message]]), events: next.events };
}
export function claudeToolResults(message) {
    const out = [];
    for (const block of contentBlocks(message)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
            const content = toolContent(block.content);
            // The Messages API defines `is_error` as optional and false by
            // default, and claude 2.1.288 leaves it out of a successful Read, Write
            // or Edit result (Bash carries `false`): an absent field is the
            // protocol's own "no error", not a missing report.
            out.push({
                kind: "tool_call_ended",
                callId: block.tool_use_id,
                ...(content === undefined ? {} : { content }),
                result: block.is_error === true ? "failed" : "ok",
            });
        }
    }
    return out;
}
