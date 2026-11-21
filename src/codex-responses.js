import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { getAxumConfigPath } from "./provider-config.js";

const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const CODEX_VERSION = "0.125.0";
const MAX_CACHE_KEY_LENGTH = 64;
const MARKER = "AXUM_CODEX_RESPONSES_V1";

function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

function cacheKey(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > MAX_CACHE_KEY_LENGTH) {
    throw new Error(`${name} must be a non-empty string of at most 64 characters`);
  }
  return value;
}

function defaultUserAgent() {
  return `codex_cli_rs/${CODEX_VERSION} (${os.type()} ${os.release()}; ${os.arch()}) ${process.env.TERM || "unknown"}`;
}

// Resolve once per logical request: transport retries reuse the same options.
// Persistent and in-memory SDK sessions already supply their own stable ID.
export function prepareCodexResponsesOptions(model, options = {}, file = getAxumConfigPath()) {
  if (!RESPONSES_APIS.has(model.api)) return options;
  const config = readConfig(file);
  const configuredKey = cacheKey(config.prompt_cache_key, "prompt_cache_key");
  const sessionId = cacheKey(options.sessionId, "sessionId") ?? randomUUID();
  const key = configuredKey ?? sessionId;
  const headers = new Headers({
    "User-Agent": process.env.AXUM_USER_AGENT || config.userAgent || defaultUserAgent(),
    originator: "codex_cli_rs",
    "session-id": sessionId,
    "thread-id": sessionId,
    session_id: sessionId,
    "x-client-request-id": sessionId,
  });
  for (const source of [config.codexHeaders, model.headers, options.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(name);
      else if (value !== undefined) headers.set(name, value);
    }
  }
  return {
    ...options,
    sessionId,
    headers: Object.fromEntries(headers),
    onPayload: async (payload, requestModel) => {
      const replacement = await options.onPayload?.(payload, requestModel);
      const body = replacement === undefined ? payload : replacement;
      if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input) || "messages" in body) {
        throw new Error("Responses payload must contain an input array, without messages");
      }
      if (body.instructions != null && typeof body.instructions !== "string") {
        throw new Error("Responses instructions must be a string");
      }
      if (body.reasoning != null && (typeof body.reasoning !== "object" || Array.isArray(body.reasoning))) {
        throw new Error("Responses reasoning must be an object");
      }
      return { ...body, prompt_cache_key: key };
    },
  };
}

// Old SDK builds overwrite caller identity and Beta headers inside builders.
// Apply the resolved values after those builders, without replacing auth.
export function finalizeCodexResponsesHeaders(headers, options, transport) {
  const configured = new Headers(options.headers);
  for (const name of ["user-agent", "originator", "session-id", "thread-id", "session_id", "x-client-request-id"]) {
    if (configured.has(name)) headers.set(name, configured.get(name));
    else headers.delete(name);
  }
  if (configured.has("openai-beta")) headers.set("openai-beta", configured.get("openai-beta"));
  else if (transport === "sse") headers.delete("openai-beta");
}

// Covers both installed provider generations and every nested pi-ai copy.
// Fail on changed anchors instead of silently losing the protocol guarantee.
export function instrumentCodexResponses(source, codex = false) {
  if (source.includes(MARKER)) return source;
  const entry = "export const stream = (model, context, options) => {";
  if (source.split(entry).length !== 2) throw new Error("Axum Codex: unsupported Responses stream entry");
  let patched = source.replace(entry, `${entry}\n    options = prepareAxumCodexResponsesOptions(model, options);`);
  if (codex) {
    for (const [variable, transport] of [["sseHeaders", "sse"], ["websocketHeaders", "websocket"]]) {
      const pattern = new RegExp(`(            const ${variable} = build\\w+Headers\\([^\\n]+;)(?=\\n)`);
      if (!pattern.test(patched)) throw new Error(`Axum Codex: unsupported ${transport} headers builder`);
      patched = patched.replace(pattern, `$1\n            finalizeAxumCodexResponsesHeaders(${variable}, options, "${transport}");`);
    }
  }
  const helper = new URL("./codex-responses.js", import.meta.url).href;
  return `// ${MARKER}\nimport { prepareCodexResponsesOptions as prepareAxumCodexResponsesOptions, finalizeCodexResponsesHeaders as finalizeAxumCodexResponsesHeaders } from ${JSON.stringify(helper)};\n${patched}`;
}
