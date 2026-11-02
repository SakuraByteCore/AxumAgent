import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AXUM_ENTRY = path.join(REPO_ROOT, "bin", "axum.js");
const CODE_ENTRY = path.join(REPO_ROOT, "bin", "code.js");
const SANDBOX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "axum-e2e-"));
const NO_USER_PACKAGES_FILE = path.join(SANDBOX_ROOT, "missing", "packages.json");
const PI_USER_AGENT_VERSIONED = [
	"export function getPiUserAgent(version) {",
	"    const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;",
	"    return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;",
	"}",
	"",
].join("\n");
const PI_USER_AGENT_BROWSER_SAFE = [
	"function loadNodeOs() {",
	"    if (typeof process === \"undefined\" || !(process.versions?.node || process.versions?.bun)) {",
	"        return null;",
	"    }",
	"    return process.getBuiltinModule?.(\"node:os\") ?? null;",
	"}",
	"const nodeOs = loadNodeOs();",
	"export function getPiUserAgent() {",
	"    return nodeOs ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : \"pi (browser)\";",
	"}",
	"",
].join("\n");
const PI_TUI_STDIN_BUFFER = [
	'const ESC = "\\x1b";',
	'const BRACKETED_PASTE_START = "\\x1b[200~";',
	'const BRACKETED_PASTE_END = "\\x1b[201~";',
	'class StdinBuffer {',
	'  process(data) {',
	'    let str;',
	'    if (Buffer.isBuffer(data)) {',
	'      str = data.toString();',
	'    } else {',
	'      str = data;',
	'    }',
	'        if (str.length === 0 && this.buffer.length === 0) {',
	'            this.emitDataSequence("");',
	'            return;',
	'        }',
	'  }',
	'}',
].join("\n");

after(() => {
	fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
});

function createSandbox(name) {
	const root = fs.mkdtempSync(path.join(SANDBOX_ROOT, name));
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	return { root, home, project, agentDir: path.join(home, ".pi", "agent") };
}

function writePackage(root, name, files = {}) {
	const dir = path.join(root, "node_modules", ...name.split("/"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js" }));
	fs.writeFileSync(path.join(dir, "index.js"), "export default {};\n");
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(dir, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}

function createFakePiRuntime(sandbox) {
	writePackage(sandbox.cache, "@earendil-works/pi-coding-agent", {
		"dist/cli.js": `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sandbox.argvFile)}, JSON.stringify(process.argv.slice(2))); console.log('Usage:\\npi [options]');`,
		"dist/utils/pi-user-agent.js": PI_USER_AGENT_VERSIONED,
		"dist/utils/tools-manager.js": "export async function ensureTool() { return undefined; }",
	});
	writePackage(sandbox.cache, "@earendil-works/pi-ai", {
		"dist/index.js": "",
		"dist/utils/pi-user-agent.js": PI_USER_AGENT_BROWSER_SAFE,
	});
	writePackage(sandbox.cache, "@earendil-works/pi-agent-core", { "dist/index.js": "" });
	writePackage(sandbox.cache, "@earendil-works/pi-tui", {
		"dist/index.js": "",
		"dist/stdin-buffer.js": PI_TUI_STDIN_BUFFER,
	});
	writePackage(sandbox.cache, "typescript", { "lib/typescript.js": "" });
}

function createFakeExtensions(sandbox) {
	const extensionFiles = {
		"pi-bar": "index.ts",
		"@narumitw/pi-goal": "src/index.ts",
		"pi-companion": "index.ts",
		"pi-hashline-edit-pro": "index.ts",
		"@gamaraan/todos-tool": "src/index.ts",
		"pi-agent": "index.ts",
		"pi-memory": "index.ts",
		"pi-remote-control": "index.js",
	};
	for (const [packageName, extensionFile] of Object.entries(extensionFiles)) {
		writePackage(sandbox.cache, packageName, { [extensionFile]: "" });
	}
	writePackage(sandbox.cache, "pi-companion", {
		"index.ts": "",
		"skills/claude-driver/SKILL.md": "# claude-driver test fixture\n",
	});
}

function writeAgentConfig(sandbox) {
	fs.writeFileSync(path.join(sandbox.agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "localmock",
		defaultModel: "mock-a",
		defaultThinkingLevel: "high",
	}));
	fs.writeFileSync(path.join(sandbox.agentDir, "models.json"), JSON.stringify({
		providers: {
			localmock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "test-key",
				models: [{ id: "mock-a", name: "mock-a", reasoning: true }],
			},
		},
	}));
}

function createBundledPiSandbox(name) {
	const sandbox = createSandbox(name);
	sandbox.cache = path.join(sandbox.root, "cache");
	sandbox.agentDir = path.join(sandbox.home, ".pi", "agent");
	sandbox.argvFile = path.join(sandbox.root, "argv.json");
	fs.mkdirSync(sandbox.agentDir, { recursive: true });
	createFakePiRuntime(sandbox);
	createFakeExtensions(sandbox);
	writeAgentConfig(sandbox);
	return sandbox;
}

function run(args, { sandbox = createSandbox("cli"), input = "", env = {}, entry = AXUM_ENTRY } = {}) {
	const { TERMUX_VERSION, PREFIX, ...baseEnv } = process.env;
	const result = spawnSync(process.execPath, [entry, ...args], {
		cwd: sandbox.project,
		encoding: "utf8",
		input,
		timeout: 180000,
		env: {
			...baseEnv,
			HOME: sandbox.home,
			USERPROFILE: sandbox.home,
			XDG_CACHE_HOME: path.join(sandbox.root, "cache"),
			XDG_CONFIG_HOME: path.join(sandbox.root, "config"),
			PI_CODING_AGENT_DIR: sandbox.agentDir,
			AXUM_USER_PACKAGES_FILE: NO_USER_PACKAGES_FILE,
			AXUM_NO_FETCH_TAGS: "1",
			...(sandbox.cache ? { AXUM_BUNDLED_PI_DIR: sandbox.cache, AXUM_BUNDLED_PI_TEST_PLATFORM: "win32" } : {}),
			...env,
		},
	});
	assert.ifError(result.error);
	return result;
}

function createExtensionPi() {
	const commands = new Map();
	const messages = [];
	const notifications = [];
	const tools = new Map();
	const providers = new Map();
	const pi = {
		commands,
		messages,
		notifications,
		tools,
		providers,
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerProvider(name, provider) {
			providers.set(name, provider);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		getModel() {
			return undefined;
		},
		on() {
			return () => {};
		},
		async sendUserMessage(message, options) {
			messages.push({ message, options });
		},
		events: {
			on() {
				return () => {};
			},
			emit() {},
		},
	};
	return pi;
}

function createExtensionContext(cwd) {
	const notifications = [];
	return {
		notifications,
		ctx: {
			hasUI: true,
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
			},
			sessionManager: {
				getSessionFile() {
					return undefined;
				},
			},
			async newSession() {
				return { cancelled: false };
			},
			getContextUsage() {
				return { tokens: 0, contextWindow: 100 };
			},
			hasPendingMessages() {
				return false;
			},
			isIdle() {
				return true;
			},
			cwd,
			model: undefined,
		},
	};
}

async function withHome(home, fn) {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
	}
}

test("e2e: axum root help lists every public command", () => {
	const result = run([]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage:\n  axum\n  axum code \[--safe\]/);
	for (const command of ["resume", "web", "chat", "doctor", "versions", "update", "install", "mcp"]) {
		assert.match(result.stdout, new RegExp(`axum ${command}`), `missing command: ${command}`);
	}
});

test("e2e: axum versions prints the installed version without network access", () => {
	const result = run(["versions"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^axum \d+\.\d+\.\d+ \(installed\)/m);
});

test("e2e: axum doctor reports a healthy bundled runtime", { timeout: 180000 }, () => {
	const sandbox = createBundledPiSandbox("doctor");
	const result = run(["doctor"], { sandbox });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Axum bundled Pi doctor/);
	assert.match(result.stdout, /^cache: /m);
	assert.match(result.stdout, /^pi cli: /m);
	assert.match(result.stdout, /^user extensions: none$/m);
	assert.match(result.stdout, /^ok$/m);
});

test("e2e: axum code --help loads the isolated bundled runtime", { timeout: 180000 }, () => {
	const sandbox = createBundledPiSandbox("code-help");
	const result = run(["code", "--help"], { sandbox });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage:/);
	assert.match(result.stdout, /pi \[options\]/);
	const argv = JSON.parse(fs.readFileSync(sandbox.argvFile, "utf8"));
	assert.equal(argv[0], "-ne");
	assert.equal(argv.filter((arg) => arg === "-e").length, 8);
	assert.deepEqual(argv.slice(-7), ["--provider", "localmock", "--model", "mock-a", "--thinking", "high", "--help"]);
});

test("e2e: axum code --safe --help disables bundled extensions without install output", { timeout: 180000 }, () => {
	const sandbox = createBundledPiSandbox("code-safe-help");
	const result = run(["code", "--safe", "--help"], { sandbox });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage:/);
	const combined = `${result.stdout}\n${result.stderr}`;
	assert.doesNotMatch(combined, /Axum first-run setup/);
	assert.doesNotMatch(combined, /installing bundled Pi/);
	const argv = JSON.parse(fs.readFileSync(sandbox.argvFile, "utf8"));
	assert.equal(argv[0], "-ne");
	assert.equal(argv.filter((arg) => arg === "-e").length, 0);
	assert.ok(!argv.includes("--safe"));
});

test("e2e: bin/code.js routes through the same isolated code entrypoint", { timeout: 180000 }, () => {
	const sandbox = createBundledPiSandbox("code-shim");
	const result = run(["--help"], { sandbox, entry: CODE_ENTRY });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pi \[options\]/);
	const argv = JSON.parse(fs.readFileSync(sandbox.argvFile, "utf8"));
	assert.equal(argv[0], "-ne");
	assert.equal(argv.filter((arg) => arg === "-e").length, 8);
	assert.ok(argv.includes("--help"));
});

test("e2e: axum web rejects an invalid port before starting a server", () => {
	const result = run(["web", "--port", "not-a-port"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Invalid port: not-a-port/);
});

test("e2e: axum mcp reports an empty isolated configuration", () => {
	const result = run(["mcp", "list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no MCP server config found/);
});

test("e2e: axum mcp add, list and remove persist one project server", () => {
	const sandbox = createSandbox("mcp-roundtrip");
	const added = run(["mcp", "add", "--project", "demo"], {
		sandbox,
		input: "npx -y demo-server\n--flag value\nTOKEN=secret\n",
	});
	assert.equal(added.status, 0, added.stderr);
	assert.match(added.stdout, /added demo -> /);

	const configFile = path.join(sandbox.project, ".pi", "mcp.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	assert.deepEqual(config.mcpServers.demo, {
		command: "npx",
		args: ["-y", "demo-server", "--flag", "value"],
		env: { TOKEN: "secret" },
	});

	const listed = run(["mcp", "list"], { sandbox });
	assert.equal(listed.status, 0, listed.stderr);
	assert.match(listed.stdout, /demo \(stdio\): npx -y demo-server --flag value/);

	const removed = run(["mcp", "remove", "demo"], { sandbox });
	assert.equal(removed.status, 0, removed.stderr);
	assert.match(removed.stdout, /removed demo from /);
	assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { mcpServers: {} });
});

test("e2e: axum mcp rejects an unknown subcommand", () => {
	const result = run(["mcp", "unknown"]);
	assert.equal(result.status, 1);
	assert.match(result.stdout, /Usage:/);
});

test("e2e: axum mcp exposes usage, install notice and removal errors", () => {
	const usage = run(["mcp"]);
	assert.equal(usage.status, 0, usage.stderr);
	assert.match(usage.stdout, /axum mcp add \[name\]/);

	const install = run(["mcp", "install"]);
	assert.equal(install.status, 0, install.stderr);
	assert.match(install.stdout, /built into the bundled Pi runtime/);

	const missingName = run(["mcp", "remove"]);
	assert.equal(missingName.status, 1);
	assert.match(missingName.stderr, /usage: axum mcp remove <name>/);

	const missingServer = run(["mcp", "remove", "absent"]);
	assert.equal(missingServer.status, 1);
	assert.match(missingServer.stderr, /no MCP server named "absent"/);
});

test("e2e: pi-companion /plan uses the real extension prompt contract", async () => {
	const sandbox = createSandbox("plan-built-in");
	await withHome(sandbox.home, async () => {
		const install = (await import("../plugin/pi-companion/index.ts")).default;
		const pi = createExtensionPi();
		const { ctx, notifications } = createExtensionContext(sandbox.project);
		install(pi);

		const plan = pi.commands.get("plan");
		assert.ok(plan, "real pi-companion must register /plan");
		await plan.handler("add user login", ctx);

		assert.equal(pi.messages.length, 1);
		assert.match(pi.messages[0].message, /^【总则】\n需求：add user login/);
		assert.match(pi.messages[0].message, /角色：首席规划官/);
		assert.match(pi.messages[0].message, /禁改动项/);
		assert.match(pi.messages[0].message, /<proposed_plan>/);
		assert.equal(pi.messages[0].options?.deliverAs, "followUp");
		assert.ok(notifications.some(({ message }) => message === "Plan sent, waiting for Agent…"));
	});
});

test("e2e: pi-companion /plan loads a user template from the isolated home", async () => {
	const sandbox = createSandbox("plan-template");
	const agentDir = path.join(sandbox.home, ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "plan-prompt.md"), "before {{requirement}} after\n", "utf8");

	await withHome(sandbox.home, async () => {
		const install = (await import("../plugin/pi-companion/index.ts")).default;
		const pi = createExtensionPi();
		const { ctx } = createExtensionContext(sandbox.project);
		install(pi);

		await pi.commands.get("plan").handler("add user login", ctx);
		assert.equal(pi.messages.length, 1);
		assert.equal(pi.messages[0].message, "before add user login after\n");
		assert.equal(pi.messages[0].options?.deliverAs, "followUp");
	});
});

test("e2e: pi-companion /plan rejects an empty requirement without sending a prompt", async () => {
	const sandbox = createSandbox("plan-empty");
	await withHome(sandbox.home, async () => {
		const install = (await import("../plugin/pi-companion/index.ts")).default;
		const pi = createExtensionPi();
		const { ctx, notifications } = createExtensionContext(sandbox.project);
		install(pi);

		await pi.commands.get("plan").handler("   ", ctx);
		assert.equal(pi.messages.length, 0);
		assert.deepEqual(notifications, [
			{ message: "Please provide a requirement: /plan <requirement>", level: "warning" },
		]);
	});
});
