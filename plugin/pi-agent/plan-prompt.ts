import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Built-in plan prompt skeleton — mirrors pi-companion's /plan fallback exactly,
// so /agent -P and /plan produce identical prompts when no template is present.
const PLAN_PROMPT_PREFIX = `[Requirement] `;
const PLAN_PROMPT_MIDDLE = `

[Objective] Discuss and finalize the technical solution: clarify the solution's details and implementation method, and formulate an actionable plan.`;
const PLAN_PROMPT_SUFFIX = `

[Rules] Focus solely on researching and discussing the solution; do not write code or generate code snippets. I will only begin generating code if you explicitly instruct me to do so. Please state the current expected outcome in plain, simple language.`;

const PLAN_PROMPT_TEMPLATE_SEGMENTS = [".pi", "agent", "plan-prompt.md"] as const;
const PLAN_PROMPT_REQUIREMENT_PLACEHOLDER = "{{requirement}}";

export function planTemplatePath(): string {
	return join(homedir(), ...PLAN_PROMPT_TEMPLATE_SEGMENTS);
}

export async function buildPlanPrompt(
	requirement: string,
	templatePath: string = planTemplatePath(),
): Promise<string> {
	if (!existsSync(templatePath)) {
		return PLAN_PROMPT_PREFIX + requirement + PLAN_PROMPT_MIDDLE + PLAN_PROMPT_SUFFIX;
	}
	const template = await readFile(templatePath, "utf8");
	if (!template.trim()) {
		throw new Error(`Plan prompt template is empty: ${templatePath}`);
	}
	if (!template.includes(PLAN_PROMPT_REQUIREMENT_PLACEHOLDER)) {
		throw new Error(
			`Plan prompt template must include ${PLAN_PROMPT_REQUIREMENT_PLACEHOLDER}: ${templatePath}`,
		);
	}
	return template.replaceAll(PLAN_PROMPT_REQUIREMENT_PLACEHOLDER, requirement);
}
