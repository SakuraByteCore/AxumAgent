import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PetState = "idle" | "working" | "thinking" | "replying" | "waiting" | "failed";
export function petState(running: boolean, waiting: number, failed: boolean): PetState {
	return waiting > 0 ? "waiting" : failed ? "failed" : running ? "working" : "idle";
}

export function petLaunchCommand(options: {
	platform: string; env: NodeJS.ProcessEnv; statePath: string; parentPid: number;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
	const { platform, env, statePath, parentPid } = options;
	if (env.AXUM_DESKTOP_PET === "0") return;
	const image = fileURLToPath(new URL("./assets/desktop-pet.png", import.meta.url));
	if (platform === "win32") return {
		command: "powershell.exe", env,
		args: ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File",
			fileURLToPath(new URL("./desktop-pet.ps1", import.meta.url)),
			"-StatePath", statePath, "-ImagePath", image, "-ParentProcessId", String(parentPid)],
	};
	if (platform !== "darwin" && platform !== "linux") return;
	if (platform === "linux" && !env.DISPLAY) return;
	return {
		command: env.AXUM_DESKTOP_PET_PYTHON || "python3",
		args: [fileURLToPath(new URL("./desktop-pet.py", import.meta.url)), statePath, image, String(parentPid)],
		env: platform === "linux" ? { ...env, QT_QPA_PLATFORM: "xcb" } : env,
	};
}

function launchPet(notify: (message: string) => void) {
	const directory = mkdtempSync(join(tmpdir(), "axum-pet-"));
	const statePath = join(directory, "state.json");
	let child: ChildProcess;
	let closed = false;
	const update = (state: PetState) => {
		if (!closed) writeFileSync(statePath, JSON.stringify({ state, updatedAt: Date.now() }));
	};
	const dispose = () => {
		if (closed) return;
		closed = true;
		child?.kill();
		rmSync(directory, { recursive: true, force: true });
	};
	update("idle");
	const launch = petLaunchCommand({ platform: process.platform, env: process.env, statePath, parentPid: process.pid })!;
	child = spawn(launch.command, launch.args, {
		windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: launch.env,
	});
	let errorText = "";
	child.stderr?.on("data", (chunk) => { errorText = (errorText + chunk.toString()).slice(-2000); });
	child.once("error", (error) => { notify(`桌面宠物启动失败：${error.message}${process.platform === "win32" ? "" : "；请安装 Python 3 与 PySide6，或设置 AXUM_DESKTOP_PET_PYTHON"}`); dispose(); });
	child.once("exit", (code, signal) => {
		if (!closed && (code || signal)) notify(`桌面宠物退出（${signal || code}）：${errorText}`);
		dispose();
	});
	return { update, dispose };
}

export function registerDesktopPet(pi: ExtensionAPI): void {
	if (!["win32", "darwin", "linux"].includes(process.platform) || process.env.AXUM_DESKTOP_PET === "0") return;
	let pet: ReturnType<typeof launchPet> | undefined;
	let running = false;
	let waiting = 0;
	let failed = false;
	let generation = 0;
	let phase: PetState = "working";
	let wrapped = new WeakSet<object>();
	const restoreDialogs: Array<() => void> = [];
	const restore = () => { for (const undo of restoreDialogs.splice(0)) undo(); wrapped = new WeakSet(); };
	const publish = () => {
		const state = petState(running, waiting, failed);
		pet?.update(state === "working" ? phase : state);
	};
	const bindDialogs = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || wrapped.has(ctx.ui)) return;
		wrapped.add(ctx.ui);
		for (const key of ["confirm", "select", "input"] as const) {
			const method = ctx.ui[key];
			const original = method.bind(ctx.ui);
			const owner = generation;
			const wrapper = async (...args: any[]) => {
				// An old dialog may settle after shutdown or a replacement session.
				if (owner !== generation) return (original as any)(...args);
				waiting++; publish();
				try { return await (original as any)(...args); }
				finally { if (owner === generation) { waiting--; publish(); } }
			};
			restoreDialogs.push(() => {
				if ((ctx.ui as any)[key] === wrapper) (ctx.ui as any)[key] = method;
			});
			(ctx.ui as any)[key] = wrapper;
		}
	};
	pi.on("session_start", (_event, ctx) => {
		generation++; restore(); pet?.dispose(); pet = undefined;
		running = false; waiting = 0; failed = false; phase = "working";
		if (!ctx.hasUI) return;
		if (process.platform === "linux" && !process.env.DISPLAY) {
			if (process.env.WAYLAND_DISPLAY) ctx.ui.notify("桌面宠物需要 XWayland（DISPLAY）；暂不支持纯 Wayland 定位与置顶。", "warning");
			return;
		}
		pet = launchPet((message) => ctx.ui.notify(message, "warning"));
		bindDialogs(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!pet) return;
		running = true; failed = false; phase = "working"; bindDialogs(ctx); publish();
	});
	pi.on("message_update", (event) => {
		if (!running || event.message.role !== "assistant") return;
		const kind = event.assistantMessageEvent.type;
		const next = kind === "thinking_start" || kind === "thinking_delta" ? "thinking"
			: kind === "text_start" || kind === "text_delta" ? "replying" : undefined;
		if (next && next !== phase) { phase = next; publish(); }
	});
	pi.on("tool_execution_start", () => { phase = "working"; publish(); });
	pi.on("tool_execution_end", (event) => {
		if (event.isError) { failed = true; publish(); }
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		phase = "working";
		if (message.stopReason === "error") failed = true;
		publish();
	});
	pi.on("agent_settled", () => { running = false; publish(); });
	pi.on("session_shutdown", () => {
		generation++; restore(); pet?.dispose(); pet = undefined;
		running = false; waiting = 0; failed = false;
	});
}
