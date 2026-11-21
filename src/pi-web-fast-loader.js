// 由终端与 Web 的 Node preload 加载；仅在内存转换 SDK 回调。
import { registerHooks } from "node:module";
import { fastControl } from "./fast-service-tier.js";
import { instrumentCodexResponses } from "./codex-responses.js";

globalThis[Symbol.for("axum.fast-service-tier.control")] = fastControl;

const helper = new URL("./fast-service-tier.js", import.meta.url).href;
const inlineStart = "onPayload: async (payload, _model) => {";
const inlineEnd = "onResponse: async (response, _model) => {";
const namedStart = "const transformProviderPayload = async (payload) => {";
const fastMarker = "applyAxumFastServiceTier";
const hookFlag = Symbol.for("axum.fast-service-tier.loader-hook");
const codexHookFlag = Symbol.for("axum.codex-responses.loader-hook");
const namedEnd = "const handleProviderResponse = async (response) => {";

export function instrumentWebSdk(source) {
  if (source.includes(fastMarker)) return source;
  const named = source.includes(namedStart);
  const start = named ? namedStart : inlineStart;
  const end = named ? namedEnd : inlineEnd;
  if (source.split(start).length !== 2 || source.split(end).length !== 2 ||
      (named && (source.includes(inlineStart) ||
        source.split("onPayload: transformProviderPayload,").length !== 2 ||
        source.split("transformProviderPayload").length !== 3))) {
    throw new Error("Axum Fast: unsupported Pi SDK payload hook; refusing to silently ignore Fast settings");
  }
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  const block = source.slice(from, to);
  if (to <= from || block.split("return payload;").length !== 2 || block.split("return runner.emitBeforeProviderRequest(payload);").length !== 2) throw new Error("Axum Fast: Pi SDK payload callback changed");
  const patched = block
    .replace(start, named ? "const transformProviderPayload = async (payload, _model) => {" : start)
    .replace("return payload;", "return applyAxumFastServiceTier(payload, _model);")
    .replace("return runner.emitBeforeProviderRequest(payload);", "return applyAxumFastServiceTier(await runner.emitBeforeProviderRequest(payload), _model);");
  return 'import { applyFastServiceTier as applyAxumFastServiceTier } from ' + JSON.stringify(helper) + ';\n' + source.slice(0, from) + patched + source.slice(to);
}

if (!globalThis[hookFlag] || !globalThis[codexHookFlag]) {
  const decorateSdk = !globalThis[hookFlag];
  const decorateResponses = !globalThis[codexHookFlag];
  globalThis[hookFlag] = true;
  globalThis[codexHookFlag] = true;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      // Keep Node 22 CommonJS require/cache semantics for untouched modules.
      if (result.format === "commonjs") return { ...result, format: "commonjs-sync" };
      if (decorateResponses && result.format === "module" && /\/@earendil-works\/pi-ai\/dist\/(?:api|providers)\/openai-(?:codex-)?responses\.js$/.test(new URL(url).pathname)) {
        return { ...result, source: instrumentCodexResponses(String(result.source), url.endsWith("/openai-codex-responses.js")) };
      }
      if (decorateSdk && url.includes("/@earendil-works/pi-coding-agent/dist/core/sdk.js") && result.format === "module") {
        const source = instrumentWebSdk(String(result.source));
        fastControl.sdkDecorated = true;
        return { ...result, source };
      }
      return result;
    },
  });
}
