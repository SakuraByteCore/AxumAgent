import type { ExtensionAPI, ExtensionCommandContext } from "./shared.js";

/** One-keystroke front doors: fixed flag presets over the shared /agent parser and lifecycle. */
export type AgentPreset = {
	name: string;
	flags: readonly string[];
	description: string;
};

export const AGENT_PRESETS: readonly AgentPreset[] = [
	{
		name: "spawn",
		flags: ["-s"],
		description:
			"Run a background agent on this conversation's context and deliver its result back automatically: /spawn <task>",
	},
	{
		name: "scout",
		flags: ["-i"],
		description:
			"Run an isolated background agent with a blank context, no session inheritance: /scout <task>",
	},
	{
		name: "blueprint",
		flags: ["-P", "-s"],
		description:
			"Run a background agent in plan mode and deliver the finished plan back automatically: /blueprint <task>",
	},
];

/** Prefix the user's task with the preset's fixed flags so it parses exactly like /agent. */
export function buildPresetArgs(preset: AgentPreset, task: string): string {
	const trimmed = task.trim();
	return trimmed ? [...preset.flags, trimmed].join(" ") : preset.flags.join(" ");
}

export type PresetDeps = {
	run: (presetArgs: string, invocation: string, ctx: ExtensionCommandContext) => Promise<void>;
};

export function registerPresets(pi: ExtensionAPI, deps: PresetDeps): void {
	for (const preset of AGENT_PRESETS) {
		pi.registerCommand(preset.name, {
			description: preset.description,
			getArgumentCompletions: () => null,
			async handler(args: string, ctx) {
				if (!args.trim()) {
					ctx.ui.notify(`Please provide a task: /${preset.name} <task>`, "warning");
					return;
				}
				await deps.run(buildPresetArgs(preset, args), `/${preset.name} ${args}`, ctx);
			},
		});
	}
}
