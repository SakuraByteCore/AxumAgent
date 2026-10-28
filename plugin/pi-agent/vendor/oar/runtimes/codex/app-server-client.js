import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { nativeErrorCause } from "../../shared/native-error.js";
import { coordinateHomeInitialization } from "./home-initialization.js";
export function startAppServerClient(command, env, configOverrides = {}, cwd, processOptions = {}) {
    const environment = sessionEnvironment(env);
    const directory = cwd ?? process.cwd();
    return coordinateHomeInitialization(environment, directory, () => createAppServerClient(command, environment, configOverrides, directory, processOptions));
}
function createAppServerClient(command, env, configOverrides, cwd, processOptions) {
    // -c KEY=VALUE injects config at launch, for every thread of this process
    // (session.ts sets sandbox_mode this way). thread/start can also set the
    // sandbox per thread, but its field is `sandbox`: an unknown field such as
    // `sandboxMode` is ignored without an error.
    const overrideArgs = Object.entries(configOverrides).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
    const { launchArgs = [], ...lineOptions } = processOptions;
    const child = spawnLineProcess(command, ["app-server", ...overrideArgs, ...launchArgs, "--listen", "stdio://"], { cwd, env, killTree: true, ...lineOptions });
    // Session initialization observes spawn failures through its pending RPC.
    // Mark this parallel promise handled while preserving its rejection for
    // callers that explicitly await spawned.
    // oxlint-disable-next-line promise/prefer-await-to-then -- client construction remains synchronous
    void child.spawned.catch(() => { });
    const pending = new Map();
    // Inbound frames and marks share one queue until `handle` registers the
    // handlers, so their relative order is the wire's whatever kind they are.
    const held = [];
    let handlers = null;
    const deliver = (delivery) => {
        if (handlers === null) {
            held.push(delivery);
        }
        else {
            delivery(handlers);
        }
    };
    let nextId = 1;
    let exitFailure = null;
    const redact = processOptions.redact ?? ((text) => text);
    child.onLine((line) => {
        const message = asRecord(parseJson(line));
        if (message === null) {
            return;
        }
        const hasId = typeof message.id === "number" || typeof message.id === "string";
        if (typeof message.method === "string") {
            const params = asRecord(message.params) ?? {};
            const { method } = message;
            if (hasId) {
                const id = String(message.id);
                deliver((target) => {
                    target.onServerRequest(id, method, params);
                });
            }
            else {
                deliver((target) => {
                    target.onNotification(method, params);
                });
            }
            return;
        }
        if (typeof message.id === "number" && pending.has(message.id)) {
            const waiter = pending.get(message.id);
            if (waiter === undefined) {
                return;
            }
            pending.delete(message.id);
            const error = asRecord(message.error);
            if (error !== null) {
                const cause = nativeErrorCause(waiter.method, error, redact);
                const failure = new Error(redact(typeof error.message === "string" ? error.message : "app-server error"), { cause });
                waiter.settled({ kind: "error", error: failure, native: cause.native });
                waiter.reject(failure);
            }
            else {
                const result = asRecord(message.result) ?? {};
                waiter.settled({ kind: "result", result });
                waiter.resolve(result);
            }
        }
    });
    child.onExit(() => {
        const diagnostics = child.diagnostics();
        exitFailure = processFailure("app-server exited", {
            ...diagnostics,
            stderr: redact(diagnostics.stderr),
            ...(diagnostics.error === undefined ? {} : { error: { ...diagnostics.error, message: redact(diagnostics.error.message) } }),
        });
        for (const waiter of pending.values()) {
            const error = exitFailure;
            waiter.settled({ kind: "exited", error });
            waiter.reject(error);
        }
        // Keep these already-settled callbacks until any remaining stdout drains.
        // A late native reply is still observable, but cannot answer a control twice.
    });
    return {
        spawned: child.spawned,
        exited: child.exited,
        async request(method, params, onSettled) {
            const settled = onSettled ?? (() => { });
            if (exitFailure !== null) {
                const error = exitFailure;
                settled({ kind: "exited", error });
                throw error;
            }
            const id = nextId;
            nextId += 1;
            // oxlint-disable-next-line promise/avoid-new -- settlement is driven by the response pump
            const timer = setTimeout(() => child.kill(), 15000);
            try {
            const result = await new Promise((resolve, reject) => {
                pending.set(id, { method, resolve, reject, settled });
                child.write(`${JSON.stringify({ id, method, params })}\n`);
            });
            return result;
            } finally { clearTimeout(timer); }
        },
        notify(method, params) {
            child.write(`${JSON.stringify({ method, params })}\n`);
        },
        handle(registered) {
            if (handlers !== null) {
                throw new Error("app-server handlers are already registered");
            }
            handlers = registered;
            for (const delivery of held.splice(0)) {
                delivery(registered);
            }
        },
        mark(callback) {
            deliver(() => {
                callback();
            });
        },
        onExit(handler) {
            child.onExit(handler);
        },
        kill() {
            child.kill();
        },
        resources: child.resources,
    };
}
