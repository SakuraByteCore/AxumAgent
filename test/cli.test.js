import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

function run(args) {
  return spawnSync(process.execPath, ["bin/axum.js", ...args], { encoding: "utf8" });
}

test("axum without args shows Axum command help", () => {
  const result = run([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:\n  axum\n  axum code \[pi args\.\.\.\]/);
  assert.match(result.stdout, /axum web/);
  assert.doesNotMatch(result.stdout, /provider web/);
});

test("provider command is no longer a public web entry", () => {
  const result = run(["provider", "web"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /axum web/);
  assert.doesNotMatch(result.stdout, /Axum provider setup:/);
});

test("axum web does not fall through to bundled Pi install", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-cli-"));
  const child = spawn(process.execPath, ["bin/axum.js", "web", "--port", "18180"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, AXUM_PROVIDER_WEB_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`axum web did not start; output: ${output}`)), 5000);
      child.stdout.on("data", () => {
        if (output.includes("Axum provider setup:")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`axum web exited early with ${code}; output: ${output}`));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotMatch(output, /Axum first-run setup/);
    assert.doesNotMatch(output, /installing bundled Pi/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
