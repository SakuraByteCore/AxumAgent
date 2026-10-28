import { randomUUID } from "node:crypto";
import { asNumber, asRecord, asRecordList } from "../../shared/json.js";
import { claudeControlResponseId } from "./effort.js";
/**
 * How long claude gets to answer. It answered in 0.5 s, mid-turn too
 * (2.1.292). No model call, but each read sends the provider a batch of
 * `count_tokens` requests (16 to 28 for a small setup, more with more tools
 * and skills), so a host reads on demand and does not poll.
 */
export const CLAUDE_CONTEXT_BREAKDOWN_MS = 10_000;
const KINDS = { used: "used", deferred: "deferred", buffer: "reserved", free: "free" };
function item(name, tokens) {
    const count = asNumber(tokens);
    return typeof name === "string" && count !== null ? [{ name, tokens: count }] : [];
}
const MCP_LOADED = "MCP tools";
const MCP_DEFERRED = "MCP tools (deferred)";
/**
 * claude's MCP tools under the MCP category its answer has. `isLoaded` does
 * not follow the category on 2.1.292: with tool search off the only category
 * is MCP tools, yet every tool says `isLoaded: false`. So `isLoaded` splits
 * them only when both categories are there.
 */
function mcpItems(payload, names) {
    const tools = asRecordList(payload.mcpTools);
    const listed = (filter) => tools.filter((tool) => filter(tool)).flatMap((tool) => item(tool.name, tool.tokens));
    if (names.has(MCP_LOADED) && names.has(MCP_DEFERRED)) {
        return [[MCP_LOADED, listed((tool) => tool.isLoaded === true)], [MCP_DEFERRED, listed((tool) => tool.isLoaded !== true)]];
    }
    const only = names.has(MCP_LOADED) ? MCP_LOADED : MCP_DEFERRED;
    return [[only, listed(() => true)]];
}
/** claude's per-entry lists, under the category each one makes up. */
function itemsByCategory(payload, names) {
    return new Map([
        ["Memory files", asRecordList(payload.memoryFiles).flatMap((file) => item(file.path, file.tokens))],
        ["Skills", asRecordList(asRecord(payload.skills)?.skillFrontmatter).flatMap((skill) => item(skill.name, skill.tokens))],
        ["Custom agents", asRecordList(payload.agents).flatMap((agent) => item(agent.agentType, agent.tokens))],
        ...mcpItems(payload, names),
    ]);
}
/** claude's `get_context_usage` (`detail: "full"`) answer, read: its categories in its order and words, with the lists that itemize them. */
export function claudeContextBreakdown(payload) {
    const tokens = asNumber(payload.totalTokens);
    const contextWindow = asNumber(payload.maxTokens);
    if (tokens === null || contextWindow === null) {
        throw new Error("claude's get_context_usage answer has no totalTokens or maxTokens");
    }
    const native = asRecordList(payload.categories);
    const items = itemsByCategory(payload, new Set(native.flatMap((category) => typeof category.name === "string" ? [category.name] : [])));
    const categories = native.flatMap((category) => {
        const tokensIn = asNumber(category.tokens);
        if (typeof category.name !== "string" || tokensIn === null) {
            return [];
        }
        const listed = items.get(category.name) ?? [];
        return [{
                name: category.name,
                tokens: tokensIn,
                kind: typeof category.kind === "string" ? (KINDS[category.kind] ?? "unknown") : "unknown",
                ...(listed.length === 0 ? {} : { items: listed }),
            }];
    });
    return { tokens, contextWindow, categories };
}
export function claudeContextBreakdownReader(child) {
    let pending = null;
    let inFlight = null;
    let gone = false;
    const ask = async () => {
        const id = `oar-context-${randomUUID()}`;
        const { promise, resolve } = Promise.withResolvers();
        pending = { id, settle: resolve };
        const timer = setTimeout(() => {
            resolve({ subtype: "error", error: `no answer within ${String(CLAUDE_CONTEXT_BREAKDOWN_MS)} ms` });
        }, CLAUDE_CONTEXT_BREAKDOWN_MS);
        try {
            child.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "get_context_usage", detail: "full" } })}\n`);
            const response = await promise;
            if (response === null) {
                return null;
            }
            if (response.subtype !== "success") {
                throw new Error(`claude did not answer get_context_usage: ${typeof response.error === "string" ? response.error : "error"}`);
            }
            return claudeContextBreakdown(asRecord(response.response) ?? {});
        }
        finally {
            clearTimeout(timer);
            pending = null;
        }
    };
    const shared = async () => {
        try {
            return await ask();
        }
        finally {
            inFlight = null;
        }
    };
    return {
        consume(message) {
            const id = claudeControlResponseId(message);
            if (id === null || !id.startsWith("oar-context-")) {
                return false;
            }
            if (pending?.id === id) {
                pending.settle(asRecord(message.response));
            }
            return true;
        },
        exited() {
            gone = true;
            pending?.settle(null);
        },
        read: async () => {
            // Ended stdin without a dispose: the abort fallback's kill, its exit still to come.
            if (gone || child.stdin.writableEnded || child.stdin.destroyed) {
                return null;
            }
            // Concurrent calls share the read in flight.
            inFlight ??= shared();
            const breakdown = await inFlight;
            return breakdown;
        },
    };
}
