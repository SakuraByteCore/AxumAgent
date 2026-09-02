import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, AgentSource, ThinkingLevel } from "./types.js";

const VALID_PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export function isValidProfileName(name: string): boolean {
	return VALID_PROFILE_NAME.test(name);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseThinking(value: unknown): ThinkingLevel | undefined | "invalid" {
	if (value === undefined || value === null || value === "inherit") {
		return undefined;
	}
	if (typeof value !== "string") {
		return "invalid";
	}
	const normalized = value.trim() as ThinkingLevel;
	return VALID_THINKING_LEVELS.has(normalized) ? normalized : "invalid";
}

function parseModel(value: unknown): string | undefined | "invalid" {
	if (value === undefined || value === null || value === "inherit") {
		return undefined;
	}
	const model = optionalString(value);
	if (!model) {
		return "invalid";
	}
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1 || model.includes(" ")) {
		return "invalid";
	}
	return model;
}

function parseToolList(value: unknown): string[] | "invalid" {
	if (typeof value !== "string") {
		return "invalid";
	}
	const tools: string[] = [];
	const seen = new Set<string>();
	for (const rawValue of value.split(",")) {
		const tool = rawValue.trim();
		if (!tool || seen.has(tool)) {
			continue;
		}
		seen.add(tool);
		tools.push(tool);
	}
	return tools.length > 0 ? tools : "invalid";
}

function parseProfileFile(
	filePath: string,
	name: string,
	source: AgentSource,
	options: { requireBody: boolean },
): AgentProfile | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch {
		return undefined;
	}

	const description = optionalString(parsed.frontmatter.description);
	const body = parsed.body.trim();
	const model = parseModel(parsed.frontmatter.model);
	const thinking = parseThinking(parsed.frontmatter.thinking);
	const tools = Object.prototype.hasOwnProperty.call(parsed.frontmatter, "tools")
		? parseToolList(parsed.frontmatter.tools)
		: undefined;

	if (!description || model === "invalid" || thinking === "invalid" || tools === "invalid" || (options.requireBody && !body)) {
		return undefined;
	}

	return {
		name,
		description,
		source,
		model,
		thinking,
		tools,
		systemPrompt: body || undefined,
	};
}

function loadProfilesFromDir(
	dir: string,
	source: AgentSource,
	options: { requireBody: boolean },
	into: Map<string, AgentProfile>,
): void {
	if (!existsSync(dir)) {
		return;
	}

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".md")) {
			continue;
		}
		const name = basename(entry, ".md");
		if (!isValidProfileName(name)) {
			continue;
		}
		const profile = parseProfileFile(join(dir, entry), name, source, options);
		if (profile) {
			into.set(name, profile);
		}
	}
}

/**
 * Profile discovery, modeled after oh-my-pi's agent sources. Precedence is
 * builtin < ~/.omp/agent/agents (oh-my-pi compat) < ~/.pi/agent/subagents
 * (user) < <cwd>/.pi/agents (project); later sources override earlier ones.
 */
export function getAgentProfiles(cwd: string, agentDir = getAgentDir()): Map<string, AgentProfile> {
	const profiles = new Map<string, AgentProfile>();
	for (const profile of BUILTIN_PROFILES) {
		profiles.set(profile.name, profile);
	}
	loadProfilesFromDir(join(homedir(), ".omp", "agent", "agents"), "omp", { requireBody: true }, profiles);
	loadProfilesFromDir(join(agentDir, "subagents"), "user", { requireBody: true }, profiles);
	loadProfilesFromDir(join(cwd, ".pi", "agents"), "project", { requireBody: true }, profiles);
	return profiles;
}

const BUILTIN_PROFILES: AgentProfile[] = [
	{
		name: "general-purpose",
		description: "General subagent with full tool access for multi-step work that needs writes or shell commands",
		source: "builtin",
		systemPrompt: [
			"You are a general-purpose subagent running inside a fresh session.",
			"Complete the delegated task end to end. You cannot launch further subagents.",
			"Do not ask the user questions; act on the briefing as given and report what you did.",
			"Finish with a concise summary of the outcome, key file paths, and anything the caller must know.",
		].join("\n"),
	},
	{
		name: "explorer",
		description: "Read-only reconnaissance: locate code, map structure, trace references, and report concise findings",
		source: "builtin",
		tools: [...READ_ONLY_TOOLS],
		systemPrompt: [
			"You are an explorer subagent with read-only tools only. You must not modify any files.",
			"Locate the requested code, map its structure, trace references, and report concise findings.",
			"Answer with exact file paths, symbol names, and key line excerpts instead of pasting large dumps.",
		].join("\n"),
	},
];
