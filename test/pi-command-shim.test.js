import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { ensurePiCommandShim, piCommandShimScript, piCommandShimTarget } from "../src/pi-command-shim.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("the pi shim forwards every call to the current axum code", () => {
  const script = piCommandShimScript({ axumPath: "/opt/axum/bin/axum" });

  assert.match(script, /^#!\/usr\/bin\/env sh/);
  assert.match(script, /AxumAgent pi shim/);
  assert.match(script, /axum_bin="\$\(command -v axum 2>\/dev\/null\)"/);
  assert.match(script, /exec "\$axum_bin" code "\$@"/);
});

test("the pi shim target is the pi agent bin directory", () => {
  const target = piCommandShimTarget({ homeDir: "/home/tester" });

  assert.equal(target, path.join("/home/tester", ".pi", "agent", "bin", "pi"));
});

test("ensurePiCommandShim writes an executable launcher and stays idempotent", () => {
  const homeDir = tempDir("pi-shim-home-");
  try {
    const first = ensurePiCommandShim({ homeDir, axumPath: "/opt/axum/bin/axum" });
    assert.equal(first.status, "written");
    assert.equal(first.target, path.join(homeDir, ".pi", "agent", "bin", "pi"));
    assert.ok(fs.existsSync(first.target));
    assert.equal(fs.statSync(first.target).mode & 0o777, 0o755, "the launcher must be executable");

    const second = ensurePiCommandShim({ homeDir, axumPath: "/opt/axum/bin/axum" });
    assert.equal(second.status, "unchanged");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("ensurePiCommandShim never overwrites a foreign pi binary", () => {
  const homeDir = tempDir("pi-shim-foreign-");
  try {
    const target = path.join(homeDir, ".pi", "agent", "bin", "pi");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/bin/sh\necho real-pi\n", { mode: 0o755 });

    const result = ensurePiCommandShim({ homeDir, axumPath: "/opt/axum/bin/axum" });

    assert.equal(result.status, "skipped-foreign");
    assert.equal(fs.readFileSync(target, "utf8"), "#!/bin/sh\necho real-pi\n");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("the installed launcher runs the axum code entry with the original arguments", () => {
  const homeDir = tempDir("pi-shim-run-");
  const fakeBin = tempDir("pi-shim-bin-");
  try {
    const fakeAxum = path.join(fakeBin, "axum");
    fs.writeFileSync(fakeAxum, "#!/bin/sh\necho \"$*\"\n", { mode: 0o755 });

    const result = ensurePiCommandShim({ homeDir, axumPath: fakeAxum });
    assert.equal(result.status, "written");

    const output = execFileSync(result.target, ["--version", "extra"], {
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });

    assert.equal(output.trim(), "code --version extra");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("the launcher drops an inherited fast loader preload", () => {
  const homeDir = tempDir("pi-shim-nodeoptions-");
  const fakeBin = tempDir("pi-shim-nodeoptions-bin-");
  try {
    const fakeAxum = path.join(fakeBin, "axum");
    fs.writeFileSync(fakeAxum, "#!/bin/sh\necho \"$NODE_OPTIONS\"\n", { mode: 0o755 });

    const result = ensurePiCommandShim({ homeDir, axumPath: fakeAxum });
    assert.equal(result.status, "written");

    const output = execFileSync(result.target, [], {
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        NODE_OPTIONS: '--import="file:///opt/axum/src/pi-web-fast-loader.js" --no-warnings',
      },
      encoding: "utf8",
    });

    assert.doesNotMatch(output, /pi-web-fast-loader\.js/, "the inherited preload must be dropped");
    assert.match(output, /--no-warnings/, "unrelated NODE_OPTIONS survive");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});
