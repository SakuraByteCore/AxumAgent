// Loaded only by axum chat and its Web server child. Transform the SDK's
// documented payload callback in memory; never edit installed dependencies.
import { registerHooks } from "node:module";

const helper = new URL("./fast-service-tier.js", import.meta.url).href;
const start = "onPayload: async (payload, _model) => {";
const end = "onResponse: async (response, _model) => {";

export function instrumentWebSdk(source) {
  if (!source.includes(start) || !source.includes(end)) throw new Error("Axum Fast: unsupported Pi SDK payload hook; refusing to silently ignore Fast settings");
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  const block = source.slice(from, to);
  if (!block.includes("return payload;") || !block.includes("return runner.emitBeforeProviderRequest(payload);")) throw new Error("Axum Fast: Pi SDK payload callback changed");
  const patched = block
    .replace("return payload;", "return applyAxumFastServiceTier(payload, _model);")
    .replace("return runner.emitBeforeProviderRequest(payload);", "return applyAxumFastServiceTier(await runner.emitBeforeProviderRequest(payload), _model);");
  return 'import { applyFastServiceTier as applyAxumFastServiceTier } from ' + JSON.stringify(helper) + ';\n' + source.slice(0, from) + patched + source.slice(to);
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.includes("/@earendil-works/pi-coding-agent/dist/core/sdk.js") && result.format === "module") {
      return { ...result, source: instrumentWebSdk(String(result.source)) };
    }
    return result;
  },
});
