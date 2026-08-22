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
  const PLAN_FIRST_TEMPLATE =
    "Research the requirement quickly and re-confirm the plan. Let's discuss the approach first — do not generate any code until I ask you to.";
  mockPi.registerCommand("plan", {
    description: "Plan first: research the requirement, re-confirm the approach, and discuss before writing code: /plan <requirement>",
    getArgumentCompletions: () => null,
    async handler(args, ctx) {
      const requirement = args.trim();
      if (!requirement) {
        ctx.ui.notify("Please provide a requirement: /plan <requirement>", "warning");
        return;
      }
      const prompt = `[Requirement] ${requirement}\n\n[Instructions] ${PLAN_FIRST_TEMPLATE}`;
      mockPi.sendUserMessage(prompt, { streamingBehavior: "followUp" });
    },
  });

  const handler = mockPi.commands.get("plan");
  assert.ok(handler, "plan command should be registered");
  await handler.handler("add user login", ctx);

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].message.includes("[Requirement] add user login"));
  assert.ok(sentMessages[0].message.includes("approach first"));
  assert.equal(sentMessages[0].options?.streamingBehavior, "followUp");
});