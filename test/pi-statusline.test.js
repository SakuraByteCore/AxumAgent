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
  assert.match(contextBlock[0], /suffix:\s*`\$\{pct\}%\$\{breath\}`/);
  assert.doesNotMatch(contextBlock[0], /bar:\s*pct/);
  assert.doesNotMatch(contextBlock[0], /barSegments:/);
});

test("context usage has a natural working breath indicator", () => {
  assert.match(statuslineSource, /const BREATH_FRAMES = \["·", "•", "●", "•"\]/);
  assert.match(statuslineSource, /const BREATH_INTERVAL_MS = 700/);
  assert.match(statuslineSource, /pi\.on\("agent_start"/);
  assert.match(statuslineSource, /pi\.on\("agent_settled"/);
  assert.match(statuslineSource, /clearInterval\(breathTimer\)/);
});
