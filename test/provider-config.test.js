import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getModelsPath, listProviders, upsertOpenAICompatibleProvider } from "../src/provider-config.js";

test("writes OpenAI-compatible provider config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-"));
  const file = path.join(dir, "models.json");
  const result = upsertOpenAICompatibleProvider({
    name: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2",
    apiKeyEnv: "KIMI_API_KEY",
  }, file);

  assert.equal(result.file, file);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(json.providers.kimi.api, "openai-completions");
  assert.equal(json.providers.kimi.apiKey, "$KIMI_API_KEY");
  assert.equal(json.providers.kimi.models[0].id, "kimi-k2");
  assert.equal(json.providers.kimi.compat.supportsDeveloperRole, false);
  assert.equal(json.providers.kimi.compat.supportsReasoningEffort, false);
  assert.deepEqual(listProviders(file)[0].models, ["kimi-k2"]);
});

test("respects PI_CODING_AGENT_DIR for models path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-agent-dir-"));
  assert.equal(getModelsPath({ PI_CODING_AGENT_DIR: dir }), path.join(dir, "models.json"));
});
