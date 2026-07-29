import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const statuslineSource = fs.readFileSync(path.join(process.cwd(), "plugin", "pi-statusline", "index.ts"), "utf8");

test("pi-statusline defaults to hyphen separator", () => {
  assert.match(statuslineSource, /separator:\s*" - "/);
  assert.doesNotMatch(statuslineSource, /separator:\s*" \| "/);
});

test("context usage renders percent without a leading bar", () => {
  const contextBlock = statuslineSource.match(/id: "context-usage",[\s\S]*?color: usageColor\(pct\),[\s\S]*?\}\);/);
  assert.ok(contextBlock, "context-usage update block should exist");
  assert.match(contextBlock[0], /suffix:\s*`\$\{pct\}%`/);
  assert.doesNotMatch(contextBlock[0], /bar:\s*pct/);
  assert.doesNotMatch(contextBlock[0], /barSegments:/);
});

test("suffix-only statusline segments stay visible", () => {
  assert.match(statuslineSource, /if \(!ev\.text && !ev\.suffix && ev\.bar === undefined\)/);
  assert.match(statuslineSource, /visible:\s*!!\(ev\.text \|\| ev\.suffix \|\| ev\.bar !== undefined\)/);
});

test("context usage has no working light animation", () => {
  assert.doesNotMatch(statuslineSource, /BREATH_FRAMES/);
  assert.doesNotMatch(statuslineSource, /WORKING_CURSOR_FRAMES/);
  assert.doesNotMatch(statuslineSource, /WORKING_LIGHT_FRAMES/);
  assert.doesNotMatch(statuslineSource, /breathTimer/);
  assert.doesNotMatch(statuslineSource, /setInterval\(/);
  assert.match(statuslineSource, /pi\.on\("agent_start"/);
  assert.match(statuslineSource, /emitContext\(ctx\);\n\s*flushIfDirty\(\);/);
  assert.match(statuslineSource, /pi\.on\("agent_settled"/);
});
