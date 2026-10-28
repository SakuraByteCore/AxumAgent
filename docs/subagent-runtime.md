# One-shot subagent runtime

## Default: controlled-pi

`dispatch_agent` is the only model-callable dispatch entry. Omitted backend selects **controlled-pi**, using bundled Pi SDK 0.99.2 and the current main-agent model/provider authentication. No Docker, new API key, external CLI, separate login or deployment setup is required. OAR was abandoned; its former Codex/Claude backends are retired, not default or optional deployment paths. Explicit retired backend requests fail clearly rather than starting a different runtime.

Each dispatch is an independent one-shot context, not a fork of parent conversation history. Package the complete goal, necessary source/context, owned paths, non-goals, input/output interfaces and acceptance checks. Historical tasks are not automatically replayed.

## Delegation policy

For worthwhile work with **two or more independent file/module/verification lanes**, dispatch early, then keep the parent on the critical path. Assign shared files to one owner, give each writable child explicit `writeScope`, and hold dependent consumers until prerequisite evidence is available. Simple or tightly coupled work stays inline; do not delegate merely to increase task count.

The parent collects all required results, inspects scoped changes and failure/partial evidence, remediates conflicts or defects, and runs unified verification before claiming delivery. Child reports are evidence, not proof of integrated correctness. Parent coding remains available. This is advisory model policy, **not a deterministic scheduler** or a guarantee that a model will choose a particular decomposition. Recursive delegation and legacy supervisor bypasses are excluded.

## Live parent tool bridge and permissions

Tool-dispatched workers use the live parent `ExtensionToolContext.executeTool` bridge: allowed builtin tools re-enter the actual parent validation, hooks and approval chain with builtin provenance. The child tool set intersects the parent active builtin tools; custom tools and recursive delegation are not forwarded. Missing proxies must not fall back to raw builtin mutation. Automatic/custom child extension discovery is disabled; only the explicit bundled response companion is loaded.

Omitting `writeScope` means read-only. Writable dispatch requires explicit owned paths inside cwd and the live bridge. `write`/`edit` targets are canonically checked, including symlink resolution; out-of-scope targets and dangling symlinks fail closed. Overlapping child write scopes reject; terminal execution releases ownership. Parent revocation, replaced/disposed contexts, shutdown and inactive/closed child capabilities invalidate access. Legacy SDK or slash-command contexts without the live bridge remain read/search-only; writable requests fail visibly.

Workers have no shell by default. `testCommands` requires explicit `writeScope` and the live bridge, authorizes **only exact command strings**, and still passes each execution through parent hooks/approval. It takes a workspace-wide exclusive child lock. Put the required checks in the task and pass their exact shell strings in `testCommands` if child execution is authorized; describing a check in prose alone does not grant shell access.

These guards are **not an OS, shell or filesystem sandbox**. Approved test/repository code runs with parent host permissions; exact command matching does not constrain that code’s effects. Reads are not confined to cwd. Path checks do not guarantee protection against hardlinks or hostile concurrent filesystem mutation/TOCTOU. The parent must coordinate its own writes and authorize code execution deliberately; child locks do not serialize parent edits. Use separate OS isolation for untrusted code, not a claim that this bridge provides it.

## Lifecycle and compatibility

`manage_agent` supports **status / wait / interrupt / close only**. Wait expiry observes state and never cancels work. Interrupt stops the current task; close explicitly tears down the child. New requirements require a new incremental dispatch after inspecting existing effects: no send/resume/rebase, in-memory continuation or automatic replay. Cancellation/deadline partial evidence must not be reported as successful completion; there is no automatic rollback of writes or retry of side effects.

There is no default task deadline. An explicit timeout includes startup and is distinct from wait observation timeout. `/agent` uses the same independent one-shot runtime but remains read-only without a live tool bridge; legacy slash contexts do not grant writable scope or shell execution. `/dispatch` and `/quick` guide the parent to dispatch; `/quick` has no implicit time budget.

Managed policy **v1–v6 migrates to v7**, replacing the managed policy while preserving surrounding custom text. Historical session data is neither deleted nor replayed. Legacy supervisor extension/package aliases remain blocked; no second model dispatch tool is introduced.

## Verification boundaries

Validate the compiled production dispatch/runner path, current-model/auth selection, one-shot lifecycle, parent hook/provenance forwarding, scope rejection, exact-command authorization, revocation and no-bridge read-only failures. Include policy migration fixtures for v1–v6 and preservation of custom text. Offline SDK/provider fixtures establish only the exercised contracts; they do not prove live-provider end-to-end success or OS isolation. Historical Codex source comparisons in [subagent-contract.md](subagent-contract.md) are labeled superseded where they discuss older Axum behavior.
