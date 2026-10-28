import { emptyInputRefusal } from "./control-input.js";
import { withSessionRecord } from "../observe/graph.js";
async function settle(decide, issued) {
    try {
        return await decide(issued);
    }
    catch (error) {
        return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
    }
}
function deliver(observer, record) {
    try {
        observer(record);
    }
    catch {
        // Observers are a side-tap; their failures must not touch the run.
    }
}
/** An optional session credential redactor runs before retention and observer delivery; native command inputs remain unchanged. */
export function createSessionKernel(sessionId = globalThis.crypto.randomUUID(), redact) {
    const observers = new Set();
    const log = [];
    const nodeIds = new Set([sessionId]);
    let graph = { nodes: [{ id: sessionId }], edges: [] };
    let seq = 0;
    let exited = false;
    let disposing = false;
    const append = (build, at) => {
        const spanId = at?.spanId;
        const record = build({
            sessionId: at?.sessionId ?? sessionId,
            agentPath: at?.agentPath ?? [],
            ...(spanId === undefined ? {} : { spanId }),
            seq,
            receivedAt: Date.now(),
        });
        seq += 1;
        const retained = redact === undefined ? record : redact(record);
        log.push(retained);
        graph = withSessionRecord(graph, retained, nodeIds);
        if (record.kind === "response" && record.body.kind === "exited") {
            exited = true;
        }
        if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "dispose") {
            disposing = true;
        }
        for (const observer of observers) {
            deliver(observer, retained);
        }
        return retained;
    };
    const unreachable = () => {
        if (exited) {
            return { kind: "rejected", code: "runtime_exited", reason: "runtime exited" };
        }
        return disposing ? { kind: "rejected", code: "disposed", reason: "session disposed" } : null;
    };
    const request = (direction, body, at) => append((envelope) => ({ ...envelope, kind: "request", id: at?.id ?? globalThis.crypto.randomUUID(), direction, body }), at);
    const respond = (requestId, body, at) => append((envelope) => ({ ...envelope, kind: "response", requestId, body }), at);
    return {
        sessionId,
        frame: (body, at) => append((envelope) => ({ ...envelope, kind: "frame", body }), at),
        request,
        respond,
        async control(body, decide, at) {
            const blocked = unreachable();
            const issued = request("toRuntime", body, at);
            const decided = blocked ?? emptyInputRefusal(body) ?? await settle(decide, { ...issued, body });
            return { request: issued, response: respond(issued.id, decided, at) };
        },
        unreachable,
        rawEvents(observer, cursor) {
            if (cursor !== undefined) {
                if (cursor.sessionId !== sessionId) {
                    throw new Error(`cursor belongs to session ${cursor.sessionId}, not ${sessionId}`);
                }
                for (const record of log) {
                    if (record.seq > cursor.afterSeq) {
                        deliver(observer, record);
                    }
                }
            }
            observers.add(observer);
            return () => {
                observers.delete(observer);
            };
        },
        records: () => log,
        graph: () => graph,
        link: (edge) => ({ kind: "session_linked", parent: edge.parent, child: edge.child, via: edge.via }),
    };
}
