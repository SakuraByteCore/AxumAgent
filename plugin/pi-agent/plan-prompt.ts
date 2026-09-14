import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Built-in plan prompt skeleton — mirrors pi-companion's /plan fallback exactly,
// so /agent -P and /plan produce identical prompts when no template is present.
const PLAN_PROMPT_PREFIX = `[Requirement] `;
const PLAN_PROMPT_MIDDLE = `

[Objective]
Talk the technical solution through and finalize it: make the details clear, make the implementation clear, and put together a concrete plan we can actually follow, with a one-sentence plain-English explanation of what to expect.`;
const PLAN_PROMPT_SUFFIX = `

[Rules]

1. Only research and discuss the solution; do not write code or give code snippets.
2. Unless I explicitly say "start writing code," do not write code.
3. Please say clearly, in plain and simple language, what result you are trying to achieve right now.`;

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
