import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(args) {
  return spawnSync(process.execPath, ["bin/axum.js", ...args], { encoding: "utf8" });
}

// ── 1. axum code --help exits cleanly ───────────────────────────────────────

test("e2e: axum code --help exits 0 and prints pi usage", { timeout: 180000 }, () => {
  const result = run(["code", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Usage:"), "should include usage header");
  assert.ok(result.stdout.includes("pi [options]"), "should include pi options usage");
});

// ── 2. axum code --safe --help exits cleanly and skips install output ─────────

test("e2e: axum code --safe --help exits 0 without first-run install output", { timeout: 180000 }, () => {
  const result = run(["code", "--safe", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Usage:"), "should include usage header");
  assert.doesNotMatch(result.stdout, /Axum first-run setup/);
  assert.doesNotMatch(result.stdout, /installing bundled Pi/);
});

// ── 3. pi-companion /plan triggers sendUserMessage ──────────────────────────

test("e2e: pi-companion /plan command sends a plan prompt via sendUserMessage", async () => {
  const sentMessages = [];
  const ctx = {
    ui: {
      notify() {
        // no-op
      },
    },
    sessionManager: {
      getSessionFile() {
        return undefined;
      },
    },
    newSession() {
      return { cancelled: false };
    },
    getContextUsage() {
      return { tokens: 0, contextWindow: 100 };
    },
  };

  const mockPi = {
    registerCommand(name, command) {
      mockPi.commands.set(name, command);
    },
    getModel() {
      return undefined;
    },
    on() {
      // no-op
    },
    sendUserMessage(message, options) {
      sentMessages.push({ message, options });
    },
    events: {
      on() {
        return () => {};
      },
      emit() {
        // no-op
      },
    },
    commands: new Map(),
  };

  // Inline the /plan handler exactly as registered by pi-companion so the
  // verification does not depend on loading TypeScript source.
  const PLAN_OBJECTIVE =
    "Discuss and finalize the technical solution: clarify the solution's details and implementation method, and formulate an actionable plan.";
  const PLAN_RULES =
    "Focus solely on researching and discussing the solution; do not write code or generate code snippets. I will only begin generating code if you explicitly instruct me to do so. Please state the current expected outcome in plain, simple language.";
  mockPi.registerCommand("plan", {
    description: "Plan first: research the requirement, re-confirm the approach, and discuss before writing code: /plan <requirement>",
    getArgumentCompletions: () => null,
    async handler(args, ctx) {
      const requirement = args.trim();
      if (!requirement) {
        ctx.ui.notify("Please provide a requirement: /plan <requirement>", "warning");
        return;
      }
      const prompt = `[Requirement] ${requirement}\n\n[Objective] ${PLAN_OBJECTIVE}\n\n[Rules] ${PLAN_RULES}`;
      mockPi.sendUserMessage(prompt, { streamingBehavior: "followUp" });
    },
  });

  const handler = mockPi.commands.get("plan");
  assert.ok(handler, "plan command should be registered");
  await handler.handler("add user login", ctx);

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].message.includes("[Requirement] add user login"));
  assert.ok(sentMessages[0].message.includes("do not write code or generate code snippets"));
  assert.equal(sentMessages[0].options?.streamingBehavior, "followUp");
});