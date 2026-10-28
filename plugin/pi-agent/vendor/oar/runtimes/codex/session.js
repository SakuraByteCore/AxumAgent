/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input and process-lifetime mechanisms. */
import { randomUUID } from "node:crypto";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { acceptCodexSteer, codexUserInput } from "./input-delivery.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import { asRecord } from "../../shared/json.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { newSessionLinks } from "../../shared/session-links.js";
import { startAppServerClient } from "./app-server-client.js";
import { CODEX_SETTINGS_REPORT_MS, codexOpenReadback, codexResumeEffortRefusal, codexThreadName, codexThreadOpen } from "./open.js";
import { foldCodexNotification, initialCodexProjection } from "./projection.js";
import { prepareCodexToolDenials } from "./tool-denials.js";
import { nameThread, openThread, rpcControl } from "./rpc-control.js";
export const codexSession = withSessionCredentials(async (installation, options, credentials) => {
    if (installation.via !== "executable") {
        throw new Error("The codex session adapter needs an executable installation");
    }
    // Threads persist so a later SessionOptions.resume can reattach; the thread
    // id is the runtime-native identity and becomes Session.id (open.ts builds
    // the request, and refuses what it cannot build before anything starts).
    const { method: openMethod, params: openParams, redact } = codexThreadOpen(options);
    if (options.sandboxMode !== "workspace-write" && options.sandboxMode !== "read-only") throw new Error("Explicit owned sandbox mode required");
    const configOverrides = { sandbox_mode: JSON.stringify(options.sandboxMode), "sandbox_workspace_write.network_access": "false" };
    // Every error the client reports goes through the redactor first: the
    // open's config carries the session's MCP credentials to codex.
    const client = startAppServerClient(installation.command, options.env, configOverrides, undefined, { redact, ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }) });
    try {
    await client.request("initialize", {
        clientInfo: { name: "oar", version: "0.0.0" },
        capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    const filteredOpenParams = await prepareCodexToolDenials(client, options, openParams);
    // The open event is marked at the reply's wire position AS the reply line
    // is read (onSettled → client.mark), not after this await: a frame codex
    // wrote in the same chunk right after the reply (thread/started) would
    // otherwise precede it. The mark runs when the handlers register below,
    // once the kernel exists; a failed open registers none, so it never runs.
    let recordOpen = null;
    const markOpen = (outcome) => {
        if (outcome.kind === "result") {
            client.mark(() => recordOpen?.());
        }
    };
    const started = await openThread(client, openMethod, async () => {
        const reply = await client.request(openMethod, filteredOpenParams, markOpen);
        return reply;
    }, options.serviceTier, options.resume);
    const threadId = asRecord(started.thread)?.id;
    if (typeof threadId !== "string") {
        client.kill();
        throw new TypeError("codex thread start/resume returned no thread id");
    }
    // The reply is codex's word on the model and effort the thread runs (the
    // open frame's events); anything but what was requested refuses the open.
    const readback = codexOpenReadback(openMethod, options, started);
    if (readback.refusal !== null) {
        client.kill();
        await client.exited;
        throw new Error(readback.refusal);
    }
    const kernel = credentials.kernel(threadId);
    const state = {
        active: null,
        spontaneous: false,
        codexTurnId: null,
        // A resume awaits codex's re-report of the thread's total so far: the
        // baseline this Session's token totals count from (projection.ts, #169).
        projection: initialCodexProjection(threadId, openMethod),
    };
    const busy = () => state.active !== null || state.spontaneous;
    const abortFallback = createAbortFallback(() => { client.kill(); });
    let disposeRequest = null;
    // A resume's effort update in flight: codex's thread/settings/updated answers it.
    let settingsWaiter = null;
    recordOpen = () => {
        kernel.frame({ type: openMethod, native: started, events: readback.events });
    };
    // Drive the pure projection fold, applying its commands to the kernel; the
    // fold owns event translation, attribution and graph links; this owns the
    // transport-only turn id and the control decisions (busy, spontaneous).
    const onNotification = (method, params) => {
        const isRoot = typeof params.threadId !== "string" || params.threadId === threadId;
        if (isRoot && method === "turn/started") {
            const startedTurn = asRecord(params.turn)?.id;
            if (!busy()) {
                // A turn we did not prompt (a drained queue submission): adopt it.
                state.spontaneous = true;
            }
            if (typeof startedTurn === "string") {
                state.codexTurnId = startedTurn;
            }
        }
        const { state: nextProjection, commands } = foldCodexNotification(state.projection, method, params);
        state.projection = nextProjection;
        const links = newSessionLinks(kernel, commands.flatMap((command) => command.kind === "link" ? [command.edge] : []));
        for (const command of commands) {
            switch (command.kind) {
                case "frame":
                    kernel.frame({ ...command.body, events: [...command.body.events, ...links] }, {
                        ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
                        ...(command.spanId === undefined ? {} : { spanId: command.spanId }),
                    });
                    break;
                case "link":
                    break;
                default:
                    break;
            }
        }
        if (isRoot && method === "turn/completed") {
            abortFallback.clear();
            state.active = null;
            state.spontaneous = false;
            state.codexTurnId = null;
        }
        if (isRoot && method === "thread/settings/updated") {
            settingsWaiter?.(params);
        }
    };
    // Approvals, user input, dynamic tools: recorded verbatim, never answered
    // (approvalPolicy never means none are expected; a dangling request is
    // the honest record when one arrives anyway).
    const onServerRequest = (id, method, params) => {
        kernel.request("toApp", { kind: "native", type: method, native: params }, { id });
    };
    // Registering flushes everything held so far in wire order: the frames
    // from before the thread existed, then the open event (the mark placed at
    // the reply), then whatever codex wrote after the reply.
    client.handle({ onNotification, onServerRequest });
    client.onExit((code) => {
        abortFallback.clear();
        // The exit is an outcome only oar observes: it answers our dispose when
        // we caused it, and stands alone when the app-server died on its own.
        kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
        state.active = null;
        state.spontaneous = false;
        state.codexTurnId = null;
    });
    if (readback.resumeEffort !== null) {
        // The resumed thread runs another level: set it on the loaded thread and
        // take codex's pushed settings (a recorded frame) as the word on it.
        const requested = readback.resumeEffort;
        const { promise: reported, resolve } = Promise.withResolvers();
        settingsWaiter = resolve;
        const timer = setTimeout(() => {
            resolve(null);
        }, CODEX_SETTINGS_REPORT_MS);
        const update = await client.request("thread/settings/update", { threadId, effort: requested })
            .then(() => null, (error) => ({ error: error instanceof Error ? error.message : String(error) }));
        const refusal = codexResumeEffortRefusal(requested, update, update === null ? await reported : null);
        clearTimeout(timer);
        settingsWaiter = null;
        if (refusal !== null) {
            client.kill();
            await client.exited;
            throw new Error(refusal);
        }
    }
    // Last, so an open refused above leaves the user's thread unrenamed.
    await nameThread(client, threadId, codexThreadName(openMethod, options, started));
    /** Turn a plan builder into a Session control member. */
    const via = (plan) => async (...args) => {
        const result = await rpcControl(kernel, client, plan(...args));
        return result;
    };
    const capabilities = { queue: { durable: true }, attribution: "nested", images: true };
    const promptPlan = (input, inputOptions) => ({
        body: { kind: "prompt", input, ...inputOptions },
        gate: (request) => {
            const refused = busy() ? { kind: "rejected", code: "busy", reason: "busy" } : inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) {
                return refused;
            }
            // Hold the slot while the RPC is in flight so a concurrent prompt is busy.
            state.active = request;
            return null;
        },
        method: "turn/start",
        params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId, ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }) }),
        onReply: (reply) => {
            const turnId = asRecord(reply.turn)?.id;
            if (typeof turnId !== "string") {
                state.active = null;
                return { kind: "rejected", code: "runtime_refused", reason: "codex turn/start returned no turn id", native: reply };
            }
            state.codexTurnId = turnId;
            return { kind: "accepted", native: reply };
        },
        onError: (message) => {
            state.active = null;
            return { kind: "rejected", code: "runtime_refused", reason: message };
        },
    });
    const steerPlan = (input, inputOptions) => {
        const expectedTurnId = state.codexTurnId;
        return {
            body: { kind: "steer", input, ...inputOptions },
            gate: () => (!busy() || expectedTurnId === null ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" } : inputImagesRefusal(capabilities, inputOptions?.images)),
            method: "turn/steer",
            params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), expectedTurnId, clientUserMessageId: inputOptions?.inputId }),
            onReply: (reply) => {
                if (expectedTurnId !== null && inputOptions?.inputId !== undefined) {
                    state.projection = { ...state.projection, inputs: acceptCodexSteer(state.projection.inputs, expectedTurnId, inputOptions.inputId) };
                }
                return { kind: "accepted", native: reply };
            },
            onError: (message) => ({ kind: "rejected", code: "runtime_refused", reason: `not_steerable: ${message}` }),
        };
    };
    // The reply carries the runtime's submission id; it is retained on the response.
    const queuePlan = (input, inputOptions) => ({
        body: { kind: "queue", input, ...inputOptions },
        gate: () => options.outputSchema === undefined ? inputImagesRefusal(capabilities, inputOptions?.images)
            : { kind: "rejected", code: "unsupported", reason: "codex queued input cannot carry outputSchema; use prompt after the current turn ends" },
        method: "thread/queue/add",
        params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId ?? randomUUID() }),
        onReply: (reply) => ({ kind: "accepted", native: reply }),
        onError: (message) => ({ kind: "rejected", code: "runtime_refused", reason: message }),
    });
    // An early or late interrupt can be refused; turn/completed is the outcome.
    const abortPlan = () => {
        let refused = null;
        return {
            body: { kind: "abort" },
            gate: () => {
                if (!busy() || state.codexTurnId === null) {
                    return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
                }
                return null;
            },
            onPending: (accept) => { refused = abortFallback.arm(accept); },
            method: "turn/interrupt",
            params: () => ({ threadId, turnId: state.codexTurnId }),
            onReply: (reply) => ({ kind: "accepted", native: reply }),
            onError: (message) => {
                refused?.();
                return { kind: "rejected", code: "runtime_refused", reason: message };
            },
        };
    };
    const session = credentials.seal({
        id: kernel.sessionId,
        capabilities,
        prompt: via(promptPlan),
        steer: via(steerPlan),
        queue: via(queuePlan),
        // No withdraw: the queue is codex's own, and thread/queue/delete is experimental and not live-verified (docs/runtimes/input-cancellation.md).
        abort: via(abortPlan),
        rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
        records: () => kernel.records(),
        graph: () => kernel.graph(),
        resources: client.resources,
        dispose: async () => {
            if (disposeRequest !== null) {
                return;
            }
            const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
            disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
            if (gone) {
                // The exit is already recorded; nothing is left to release.
                kernel.respond(disposeRequest.id, { kind: "accepted" });
                return;
            }
            client.kill();
            // Await the actual exit: the process may hold state (codex's sqlite
            // runtime in CODEX_HOME) that the next session needs released. The
            // exit response is recorded by onExit.
            await client.exited;
        },
    });
    return session;
    } catch (error) { client.kill(); await client.exited; throw error; }
});
