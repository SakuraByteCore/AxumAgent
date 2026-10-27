import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { AgentSession } from "./shared.js";

/** Reuse the exact companion guard loaded by the main Axum session. */
export function childRecoveryExtensions(options: {
	noExtensions?: boolean;
	extensions?: string[];
}): string[] {
	const extensions = options.extensions ?? [];
	if (options.noExtensions) return extensions;
	const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
	const companion = fileURLToPath(new URL(`../pi-companion/index.${suffix}`, import.meta.url));
	const companionDirectory = path.dirname(companion);
	const alreadyLoaded = extensions.some((entry) =>
		entry === companionDirectory || (path.dirname(entry) === companionDirectory && /^index\.(ts|js)$/.test(path.basename(entry))),
	);
	return alreadyLoaded ? extensions : [...extensions, companion];
}

/** Guard follow-ups can outlive the initial prompt; do not deliver intermediate errors. */
export async function promptChildUntilSettled(session: AgentSession, instruction: string): Promise<void> {
	await session.prompt(instruction);
	await session.waitForIdle();
}
