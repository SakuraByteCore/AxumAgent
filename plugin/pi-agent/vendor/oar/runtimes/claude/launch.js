import { claudeServiceTierArgs } from "./service-tier.js";
import { refuseManagedLaunchArgs } from "./launch-args.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { claudeSessionEnv } from "./environment.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { givenMcpServers } from "../../shared/mcp-servers.js";
import { checkSessionName } from "../../shared/session-options.js";
import { handOverMcpConfig, sweepAbandonedMcpConfigs } from "./mcp-config.js";
function spawnClaude(command, sessionId, options, mcpConfig, tierArgs) {
    const directories = resolvedAdditionalDirectories(options);
    return spawnLineProcess(command, [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose", "--replay-user-messages", "--include-partial-messages",
        // YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
        // no human at an approval prompt: a permission gate is a hang, not
        // safety. Isolation is the sandbox's job, not the approval flow's.
        // Axum security patch: never bypass native permissions, including omitted mode.
        ...((options.launchArgs ?? []).some(arg => arg === "--permission-mode" || arg.startsWith("--permission-mode="))
            ? [] : ["--permission-mode", "dontAsk"]),
        ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
        // SessionOptions.name (#368) names a new session only: `--name` on a
        // resume replaces the name the session has, which may be the user's
        // ([env] claude 2.1.292: it reports the old one as session_title_changed
        // at startup, and a new `--name` overwrites it).
        ...(options.resume !== undefined || options.name === undefined ? [] : ["--name", options.name]),
        ...(options.model === undefined ? [] : ["--model", options.model]),
        ...(options.effort === undefined ? [] : ["--effort", options.effort]),
        ...tierArgs,
        ...(options.outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(options.outputSchema)]),
        ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
        ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
        // The host's own flags, unchecked (SessionOptions.launchArgs), ahead of
        // the variadic flags below so none swallows them as values.
        ...options.launchArgs ?? [],
        ...(directories.length === 0 ? [] : ["--add-dir", ...directories]),
        ...(mcpConfig === null ? [] : ["--mcp-config", mcpConfig]),
        ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--disallowed-tools", ...options.disallowedTools ?? []]),
    ], {
        cwd: options.cwd,
        // Without the parent session's markers, so print mode chooses sdk-cli and
        // claude is not a child of the host's own claude (environment.ts).
        env: sessionEnvironment(claudeSessionEnv(options.env)),
        // On Windows an npm .cmd wrapper can exit while native claude keeps
        // the provider request and stdio alive. Teardown must reach both.
        killTree: true,
    });
}
/**
 * Start claude for a session (`--session-id`, or `--resume` an existing one)
 * and wait until it runs; with MCP servers, their config is handed over as
 * mcp-config.ts describes and gone at the latest when the process exits.
 * Rejects on a list with an empty or repeated name, or `launchArgs` that
 * collide with a flag OAR manages (launch-args.ts), before anything starts,
 * and when claude cannot be spawned.
 */
export async function launchClaude(command, sessionId, options) {
    refuseManagedLaunchArgs(options.launchArgs);
    checkSessionName(options);
    const tierArgs = claudeServiceTierArgs(options.serviceTier);
    const servers = givenMcpServers(options.mcpServers);
    // Either way, what dead hosts left behind goes first (mcp-config.ts).
    const mcpConfig = servers === null ? null : await handOverMcpConfig(servers);
    if (mcpConfig === null) {
        await sweepAbandonedMcpConfigs();
    }
    let child = null;
    try {
        child = spawnClaude(command, sessionId, options, mcpConfig?.path ?? null, tierArgs);
    }
    finally {
        if (child === null) {
            mcpConfig?.end();
        }
    }
    if (mcpConfig !== null) {
        // Fires once, for an exit or a failed spawn alike, before `exited` resolves.
        child.onExit(() => {
            mcpConfig.end();
        });
        mcpConfig.start();
    }
    await child.spawned;
    return child;
}
