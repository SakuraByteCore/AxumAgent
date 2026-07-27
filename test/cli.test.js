import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

function run(args) {
  return spawnSync(process.execPath, ["bin/axum.js", ...args], { encoding: "utf8" });
}

function writePackage(root, name, files = {}) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
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

test("axum code disables ambient extensions before loading bundled extensions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-cli-bundled-"));
  const agentDir = path.join(dir, "agent");
  const cache = path.join(dir, "cache");
  const argvFile = path.join(dir, "argv.json");
  writePackage(cache, "@earendil-works/pi-coding-agent", {
    "dist/cli.js": `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
    "dist/utils/tools-manager.js": "const chalk = { yellow: (s) => s };\nconst platform = () => process.platform;\nconst TERMUX_PACKAGES = {};\nconst config = { name: 'test' };\nfunction getToolPath() { return undefined; }\nasync function ensureTool(tool, { silent = false } = {}) {\n    if (platform() === \"android\") {\n        const pkgName = TERMUX_PACKAGES[tool] ?? tool;\n        if (!silent) {\n            console.log(chalk.yellow(\`${config.name} not found. Install with: pkg install ${pkgName}\`));\n        }\n        return undefined;\n    }\n}\nexport { ensureTool };\n",
  });
  writePackage(cache, "@earendil-works/pi-tui", {
    "dist/stdin-buffer.js": `const ESC = "\\x1b";
const BRACKETED_PASTE_START = "\\x1b[200~";
const BRACKETED_PASTE_END = "\\x1b[201~";
class StdinBuffer {
  process(data) {
    let str;
    if (Buffer.isBuffer(data)) {
      str = data.toString();
    } else {
      str = data;
    }
        if (str.length === 0 && this.buffer.length === 0) {
            this.emitDataSequence("");
            return;
        }
  }
}
`,
  });
  writePackage(cache, "pi-subagents", { "index.ts": "" });
  writePackage(cache, "pi-hermes-memory", { "src/index.ts": "" });
  writePackage(cache, "pi-rtk-optimizer", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-statusline", { "src/index.ts": "" });
  writePackage(cache, "@juicesharp/rpiv-todo", { "index.ts": "" });

  const result = spawnSync(process.execPath, ["bin/axum.js", "code", "--help"], {
    encoding: "utf8",
    env: { ...process.env, AXUM_BUNDLED_PI_DIR: cache, PI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.equal(argv[0], "-ne");
  const expectedExtensionCount = process.platform === "win32" ? 4 : 5;
  assert.equal(argv.filter((arg) => arg === "-e").length, expectedExtensionCount);
  assert.equal(argv.at(-1), "--help");
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
