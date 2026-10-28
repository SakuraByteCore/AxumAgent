# One-shot subagent runtimes

## Default: real OAR Codex

`dispatch_agent` is the only model-callable dispatch entry. Omitted backend selects **oar-codex**, the actual vendored @botiverse/oar 0.67.0 Codex app-server transport, session/kernel and turn observation. It does not invoke Pi or silently fall back. Workers run native read/write/test tools in independent project snapshots; the parent receives root assistant text and integrates only authorized file diffs. Missing deployment settings, Docker or sandbox support fail visibly. Main-agent coding is not disabled; controlled-pi remains explicit compatibility.

The parent proactively batches worthwhile independent file-owned lanes, retains the critical path and reviews integrated results. Every task contains its full goal, necessary source context, owned files, interfaces, non-goals and checks. This is model policy, not a deterministic scheduler. Assign shared files to one owner; dependency consumers wait for prerequisite evidence. No recursive delegation or legacy supervisor bypass.

## Permission model

Native approval requests cannot be bridged to Pi parent approvals. The alternative is **explicit writeScope authorization + mandatory whole-process container isolation + Codex sandbox + checked diff integration**, not an inherited approval claim. Omit writeScope for read-only. Native tests belong in the task acceptance checks; testCommands is rejected for OAR because an exact shell allowlist cannot be enforced by this transport. Parent Pi hooks do not inspect native commands. Choose explicit controlled-pi when parent per-tool approval is required.

Each worker snapshots safe regular project files, including uncommitted inputs, excluding .git, node_modules, .pi/.codex/.claude/MCP configuration, credential directories and common secret filenames. Ordinary symlinks, hardlinks and special files fail closed; limits are 20,000 entries and 128 MiB. Scopes are literal relative file/directory paths, not globs or absolute paths. Snapshot inputs may contain secrets embedded in ordinary source: this is not a secret scanner. Do not delegate a project containing sensitive source that the configured provider must not see.

The container exposes only that snapshot, never host HOME, Git metadata, credentials/configuration directories, Docker socket or arbitrary host mounts. Its root is read-only, capabilities dropped, no privilege escalation, ephemeral HOME/tmp, no parent environment inheritance, no MCP servers. A trusted deployment image supplies Codex and required project toolchains/dependencies; no host node_modules mount is added. A dedicated explicitly supplied provider credential is delegated to the app-server, not arbitrary ambient credentials. The app-server needs provider network access; native shell sandbox networking is disabled. The trusted image, Docker daemon and Codex sandbox implementation remain trusted computing components, not guarantees against a compromised kernel/runtime/image. Do not put unrelated secrets in the image.

Codex always uses workspace-write or read-only, approvalPolicy never (sandbox denials fail, not bypass), and fixed security configuration. No danger-full-access, skip-permissions, task-provided launch flags, inherited user/project configuration or MCP configuration. Read-only uses a read-only workspace mount as well. A host unable to enforce the native sandbox cannot execute the task. Do not disable sandbox or change host security settings to make it pass.

After native termination and successful cleanup, integration validates the **complete diff** against writeScope and parent baseline before writing anything. Disjoint child scopes can run in parallel; overlaps reject. Parent edits to changed files cause conflict rather than overwrite. Failed integration retains the snapshot path in the error for explicit inspection, manual integration and cleanup, never automatic replay. The parent must coordinate its own writes. Application uses atomic per-file replacement, not a multi-file transaction; I/O failure can leave applied files and must be inspected before any new incremental task. Portable Node APIs do not eliminate malicious concurrent host filesystem TOCTOU. Empty directories and directory/file type replacement are unsupported. Remove test artifacts outside scope before completion; protected outputs are rejected, not merged.

Cancellation and explicit deadlines return partial evidence; valid scoped partial changes can still integrate, never be reported as successful completion. There is no automatic side-effect retry or rollback. Cleanup failure is separate and retains occupancy/scope ownership; snapshot cleanup/integration is withheld if the runtime may remain alive. Inspect the owned runtime before restarting.

## Deployment

Axum's general Node engine remains >=22.19.0; OAR native delegation requires **Node >=24**. Provision a trusted Linux Docker host, local digest-pinned image containing /usr/local/bin/codex with app-server and working Linux sandbox, plus project test toolchains. Pull/build/audit images explicitly outside task execution; automatic pulls are disabled. Current host rejects Landlock and bubblewrap namespaces and has no Docker: real native model/sandbox acceptance was waived, not sandbox enforcement.

Set deployment-owned environment (not model tool arguments):

- AXUM_OAR_CODEX_IMAGE: audited local image reference with @sha256: digest.
- AXUM_OAR_CODEX_API_KEY: dedicated provider key; never read host Codex auth files.
- AXUM_OAR_CODEX_BASE_URL: credential-free HTTPS Responses API endpoint.
- AXUM_OAR_CODEX_MODEL: native model id supported by that endpoint.

Docker CLI is /usr/bin/docker. An operator must provision these prerequisites; no installation, login or host security changes occur automatically. Run Axum as a non-root Linux account; container uid/gid matches it so private snapshot modes remain usable. The image must be compatible with non-root execution and native sandboxing under the fixed Docker restrictions. Validate native model completion, read/write/tests and negative filesystem/network cases on the target sandbox-capable host before production rollout. Offline fixtures do not replace that deployment acceptance.

## Lifecycle and compatibility

Runtime.start returns RunHandle with result/wait/cancel/dispose. No default deadline; explicit timeout includes startup. manage_agent offers status/wait/interrupt/close only. Wait expiry observes, never cancels. New requirements need a new incremental task after checking existing effects. No send/resume/rebase or automatic replay of historical tasks. /agent uses the same default native lifecycle, read-only without a tool-supplied scope; Pi CLI/model flags are not native overrides and fail clearly. /dispatch and /quick guide the parent to dispatch; /quick has no implicit time budget.

Explicit controlled-pi retains bundled SDK 0.99.2 one-shot tasks, parent executeTool hooks/provenance, scoped writes and exact testCommands. It is not an OS sandbox and requires the live parent bridge for writes; legacy command contexts are read-only. Explicit oar-claude-text retains supplied-text-only analysis with native tools/MCP disabled, not coding parity.

Managed subagent policy v1–v5 migrates to v6, preserving surrounding custom text. Historical session data is not deleted/replayed. Legacy supervisor extension/package aliases remain blocked; no second model dispatch tool is introduced.

## Source and verification

Reference: deepseek-ai/deepseek-harness fixed f3803c96974ad4a94195fb97e5c637e9c2a3afe3, experimental/subagent-oar run/environment and tool-subagent-oar, and OAR patch/license. The Cordis provider is not imported as a Pi plugin. The dependency-closed OAR subset avoids its Pi 1.3 SDK. Apache-2.0 vendor license and NOTICE preserve upstream attribution and record local security/cleanup changes; pi-agent remains MIT and root FSL-1.1-ALv2 is unchanged. External transport dependencies remain pinned cross-spawn 7.0.6 and which 2.0.2.

Offline validation uses real OAR JSON-RPC transport fixtures and actual compiled production entrypoints, plus lifecycle, isolation-plan, readonly, env/config injection, diff integration, ownership/concurrency and cancellation regressions. It makes no provider requests. Real native model completion and OS sandbox/container execution have **not been tested on this host**; no claim of native end-to-end success is made.
