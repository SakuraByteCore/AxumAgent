import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { refreshModelInput, registerModelInputRefresh } from "../plugin/pi-companion/model-input.ts";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-model-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "models.json");
  const save = (input) => fs.writeFileSync(file, JSON.stringify({ providers: { test: { models: [{ id: "current", input }] } } }));
  return { root, file, save, ctx: { model: { provider: "test", id: "current", input: ["text"], api: "openai-completions" } } };
}

test("refreshes only explicit declarations on the current live model without changing identity", async (t) => {
  const f = fixture(t), original = f.ctx.model;
  f.save(["text", "image"]); await refreshModelInput(f.ctx, f.file);
  assert.equal(f.ctx.model, original); assert.deepEqual(original.input, ["text", "image"]);
  f.save(["text"]); await refreshModelInput(f.ctx, f.file); assert.deepEqual(original.input, ["text"]);
  f.save(undefined); await refreshModelInput(f.ctx, f.file); assert.deepEqual(original.input, ["text"]);
  f.save(["audio"]); await assert.rejects(refreshModelInput(f.ctx, f.file), /Invalid input/);
  assert.deepEqual(original.input, ["text"]);
});

test("refresh hooks never register a vision command or replace image content", async (t) => {
  const f = fixture(t), handlers = new Map(), old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.root;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  registerModelInputRefresh({ on: (event, fn) => handlers.set(event, fn) });
  f.save(["text", "image"]);
  const image = { type: "image", data: "original-bytes", mimeType: "image/png" };
  const event = { images: [image] };
  for (const handler of handlers.values()) assert.equal(await handler(event, f.ctx), undefined);
  assert.equal(event.images[0], image); assert.deepEqual(f.ctx.model.input, ["text", "image"]);
  assert.deepEqual([...handlers.keys()], ["input", "before_agent_start", "tool_call", "model_select"]);
});

const sdkRoot = process.env.AXUM_INTEGRATION_NODE_MODULES;
test("native read retains original image bytes and provider payload after live refresh", { skip: !sdkRoot }, async (t) => {
  const f = fixture(t);
  const readFile = path.join(sdkRoot, "@earendil-works/pi-coding-agent/dist/core/tools/read.js");
  const { createReadToolDefinition } = await import(pathToFileURL(readFile).href);
  const aiFile = path.join(sdkRoot, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js");
  const { streamSimple } = await import(pathToFileURL(aiFile).href);
  const imageFile = path.join(f.root, "probe.png");
  fs.writeFileSync(imageFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6K1sAAAAASUVORK5CYII=", "base64"));
  const read = createReadToolDefinition(process.cwd(), { autoResizeImages: false });
  const before = await read.execute("before", { path: imageFile }, undefined, undefined, f.ctx);
  assert.ok(before.content.some(part => part.type === "text" && part.text.includes("does not support images")));
  f.save(["text", "image"]); await refreshModelInput(f.ctx, f.file);
  const after = await read.execute("after", { path: imageFile }, undefined, undefined, f.ctx);
  const image = after.content.find(part => part.type === "image");
  assert.ok(image); assert.equal(image.data, fs.readFileSync(imageFile).toString("base64"));
  assert.ok(!after.content.some(part => part.type === "text" && part.text.includes("does not support images")));
  let payload;
  const model = { ...f.ctx.model, name: "test", baseUrl: "http://127.0.0.1:1", reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "Describe" }, image], timestamp: Date.now() }] }, { apiKey: "test-only", maxTokens: 32, onPayload: value => { payload = value; throw new Error("Captured payload without network"); } });
  await stream.result();
  assert.ok(JSON.stringify(payload).includes(`data:image/png;base64,${image.data}`));
});
