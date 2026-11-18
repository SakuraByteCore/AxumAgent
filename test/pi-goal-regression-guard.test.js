import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { applyBundledPiPatches, patchPiGoalRegressionGuard, PI_GOAL_REGRESSION_GUARD_CLAUSE } from "../src/bundled-pi-patches.js";
import { compileExtensionPackage } from "../src/compile-bundled-extensions.js";

const source = `function goalModeRules(goalLabel: string) {
  return [
    "Goal-mode rules:",
    "Preserve the full objective across turns.",
    goalLabel,
  ].join("\\n");
}
export function buildGoalPrompt(goal: string) { return goalModeRules(goal); }
export function buildObjectiveUpdatedPrompt(goal: string) { return goalModeRules(goal); }
export function buildResumePrompt(goal: string) { return goalModeRules(goal); }
export function buildGoalSystemPrompt(goal: string) { return goalModeRules(goal); }
export function buildContinuePrompt(goal: string) { return goalModeRules(goal); }
`;

test("goal prompt patch preserves existing rules and is idempotent for TS and JS", async () => {
  for (const input of [source, stripTypeScriptTypes(source, { mode: "transform" })]) {
    const patched = patchPiGoalRegressionGuard(input);
    assert.notEqual(patched, input);
    assert.equal(patchPiGoalRegressionGuard(patched), patched);
    assert.equal(patched.replace(`\n        ${JSON.stringify(PI_GOAL_REGRESSION_GUARD_CLAUSE)},`, ""), input);
    const module = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(patched, { mode: "transform" }))}`);
    for (const buildPrompt of Object.values(module)) {
      const prompt = buildPrompt("original goal");
      assert.equal(prompt.split(PI_GOAL_REGRESSION_GUARD_CLAUSE).length - 1, 1);
      assert.ok(prompt.includes("Preserve the full objective across turns."));
      assert.ok(prompt.includes("original goal"));
    }
  }
  assert.equal(patchPiGoalRegressionGuard("upstream reshaped"), "upstream reshaped");
});

test("bundled patches update goal sources and warm JS caches without duplicate injection", async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-goal-guard-"));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const modules = path.join(cache, "node_modules");
  const goalRoot = path.join(modules, "@narumitw", "pi-goal");
  for (const [file, text] of [
    ["@earendil-works/pi-tui/dist/stdin-buffer.js", "// looksLikeUnbracketedPaste"],
    ["@earendil-works/pi-coding-agent/dist/utils/pi-user-agent.js", "// AXUM_PI_USER_AGENT_CUSTOM"],
    ["@narumitw/pi-goal/package.json", '{"type":"module"}'],
    ["@narumitw/pi-goal/src/prompts.ts", source],
  ]) {
    const target = path.join(modules, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  compileExtensionPackage({ packageRoot: goalRoot });
  const options = { platform: "linux", env: { AXUM_BUNDLED_PI_DIR: cache } };
  const results = applyBundledPiPatches(options);
  for (const extension of ["ts", "js"]) {
    const file = path.join(goalRoot, "src", `prompts.${extension}`);
    assert.ok(results.some((result) => result.file === file && result.patched));
    assert.ok(fs.readFileSync(file, "utf8").includes(PI_GOAL_REGRESSION_GUARD_CLAUSE));
  }
  assert.ok(applyBundledPiPatches(options).every((result) => !result.patched));
  compileExtensionPackage({ packageRoot: goalRoot });
  const module = await import(pathToFileURL(path.join(goalRoot, "src", "prompts.js")).href);
  assert.ok(module.buildContinuePrompt("goal").includes(PI_GOAL_REGRESSION_GUARD_CLAUSE));
});
