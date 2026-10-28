# pi-agent — Axum bundled fork

Vendored from [@giladbarnea/pi-user-agents](https://github.com/giladbarnea/pi-user-agents). This guide describes the current Axum fork, not the upstream interactive-session lifecycle.

## Default runtime

`controlled-pi` is the built-in default. Workers use the main agent’s configured model, provider and authentication; no Docker, external CLI, separate login or extra API key is required. This is a controlled Pi SDK child, not an OS/container sandbox.

Every dispatch is an independent **one-shot task**, not a fork of the conversation. Supply the complete goal, necessary source context, owned files, interface constraints, non-goals and acceptance checks explicitly. Model/provider configuration reuse does not imply conversation-history inheritance.

## Delegation policy

For two or more worthwhile independent file, module or validation lanes, the parent should dispatch early and keep working on the critical path. Give each writable lane exclusive ownership; assign shared files to one owner and let dependency consumers wait for prerequisite evidence. Simple or tightly coupled tasks stay inline.

The parent collects results, reviews edits and evidence, remediates omissions or conflicts, integrates the work and performs unified verification before reporting completion. Child completion alone is not acceptance. This is model policy, not a deterministic scheduler: the model decides whether splitting is worthwhile; the host enforces permissions, admission and lifecycle constraints.

## Commands and tools

```text
/spawn fix the login bug        # /agent -s: one-shot task, automatic result delivery
/scout explain parser behavior  # /agent -i: independent research
/blueprint add dark mode        # /agent -P -s: one-shot planning
```

`/agent [options] <task>` uses the same one-shot lifecycle. Presets do not inherit conversation history. `/dispatch` asks the parent to split worthwhile independent work and use `dispatch_agent`, the sole model-callable child creation entrypoint. `/quick <goal>` requests concise process prose without an implicit deadline or disabling parallelism; an explicit budget remains an explicit budget.

`-P` / `--plan` wraps the task in the plan template from `~/.pi/agent/plan-prompt.md`, or the built-in template if absent. A present template must be non-empty and contain `{{requirement}}`. `/blueprint` returns its finished plan verbatim. A subsequent implementation is a new task with the plan and required context supplied explicitly.

## Lifecycle and result collection

`dispatch_agent` returns a stable session-local agent ID; an optional `batchId` groups tasks. `manage_agent` supports only:

- `status`: inspect task or batch state and available evidence.
- `wait`: collect results; a wait timeout only ends observation, not execution.
- `interrupt`: stop active work; inspect partial effects before another dispatch.
- `close`: stop/dispose the selected task or batch.

There is no `send`, `resume` or `rebase`, no interactive steering or second turn on an old child, and no automatic replay of historical tasks. New requirements or remediation require a new incremental task after checking existing file effects. Explicit `timeoutMs` is an execution deadline including startup, not a collection budget; deadline/cancellation evidence is partial, not successful completion. Cancelling a parent wait does not itself cancel accepted work. The parent owns collection, outstanding-lane cleanup and final synthesis.

Squash-enabled results return automatically. `squash=false` leaves a user-visible transcript entry without automatically injecting it into model context or triggering a parent turn; collect through explicit management. Memory children do not survive process restart; persisted result cards are not resumable workers.

## Permissions and validation

Writable dispatch requires an explicit `writeScope` within the project and the live parent `executeTool` approval bridge. Omit the scope for read-only work. Allowed builtin tools pass through parent validation/hooks/approval; custom tools and recursive delegation are excluded. Overlapping active child write scopes reject. The parent must also coordinate its own writes. Missing writable capabilities fail explicitly rather than silently bypassing approvals.

Workers have no shell by default. `testCommands` authorizes exact command strings via parent hooks and requires a workspace-wide exclusive child lock. Approved repository code executes with host permissions: this is **not a filesystem or shell sandbox**. Read tools are not restricted to cwd; path guards do not defend against hostile concurrent filesystem mutation or hardlinks. Do not delegate untrusted execution on this basis.

Slash-command or legacy contexts without the live parent executor remain read/search-only; companion advice is not approval. Automatic/custom child extension discovery is disabled.

## Compatibility boundary

Old upstream descriptions of inherited conversation snapshots, steering, multi-turn continuation, `/agent resume` and raw-history rebase are historical and do not describe this fork’s current contract. Existing historical data is not replayed. Legacy `pi-subagents` loading and supervisor/delegation tool aliases are blocked; unrelated custom packages are not disabled. This loading restriction is not an OS sandbox against malicious extensions.

For parser implementation details see [PARSER_SPEC.md](PARSER_SPEC.md); older parser/internal design notes may describe historical behavior and do not override the one-shot contract above.
