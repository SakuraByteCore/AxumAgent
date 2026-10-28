import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOarRuntime, type Runtime } from './runtime.js';
const execute = promisify(execFile);
/** Narrow initial OAR integration: supplied-text work only, no native tools or MCP.
 * Writable/test tasks must use controlled-pi and its live parent approval bridge.
 * This is not an OS sandbox. The native CLI itself remains trusted software.
 */
export const OAR_TEXT_ARGS = Object.freeze([
 '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config',
 '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
 '--settings', '{"disableAllHooks":true,"enabledPlugins":{}}',
 '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
]);
export function assertOarRequest(permissions?: { writeScope?: string[]; testCommands?: string[] }): void {
 if (permissions?.writeScope?.length || permissions?.testCommands?.length)
  throw new Error('oar-claude-text cannot enforce parent writeScope/testCommands; use controlled-pi. No native session started.');
 if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('oar-claude-text requires Node >=24; controlled-pi remains available on Node 22.');
}
/** Ambient provider credentials and plugin markers are not delegated. Native login
 * files remain available: native CLI installation/configuration is a trust boundary.
 */
export function oarEnvironment(): Record<string, null> {
 return Object.fromEntries(Object.keys(process.env).filter(name => /TOKEN|API_?KEY|SECRET|PASSWORD|DSH_|CLAUDE_CODE_|ANTHROPIC_|OPENAI_/i.test(name)).map(name => [name, null]));
}
export async function loadOarTextRuntime(): Promise<Runtime> {
 assertOarRequest();
 // Lazy imports prevent mixing OAR's newer Pi SDK into Axum's bundled SDK 0.99.2.
 // Vendored closure contains only Claude transport + observation, not OAR's registry/Pi runtime.
 const { claudeInstallation } = await import('./vendor/oar/runtimes/claude/installation.js');
 const { claudeSession } = await import('./vendor/oar/runtimes/claude/session.js');
 const { awaitTurnEnd } = await import('./vendor/oar/observe/turns.js');
 const installation = async () => {
  const snapshot = await claudeInstallation();
  if (snapshot.kind !== 'available') return snapshot;
  const { stdout } = await execute(snapshot.command, ['--help'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  for (const flag of ['--permission-mode','--tools','--strict-mcp-config','--mcp-config','--setting-sources','--settings','--disable-slash-commands','--no-chrome','--no-session-persistence'])
   if (!stdout.includes(flag)) throw new Error('Installed Claude CLI lacks required safety flags; update it explicitly or use controlled-pi.');
  return snapshot;
 };
 return createOarRuntime({ installation, session: claudeSession } as any, awaitTurnEnd as any, { launchArgs: OAR_TEXT_ARGS, env: oarEnvironment() });
}
