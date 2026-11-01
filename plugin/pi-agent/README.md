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

`/agent [options] <task>` 请求主线程调用一次 `dispatch_agent`，通过 `fullTools:true` 继承全部已启用的父工具；原始参数经 `agentArgs` 保留。仍采用一次性任务生命周期。 Presets do not inherit conversation history. `/dispatch` asks the parent to split worthwhile independent work and use `dispatch_agent`, the sole model-callable child creation entrypoint. `/quick <goal>` requests concise process prose without an implicit deadline or disabling parallelism; an explicit budget remains an explicit budget.

`-P` / `--plan` wraps the task in the plan template from `~/.pi/agent/plan-prompt.md`, or the built-in template if absent. A present template must be non-empty and contain `{{requirement}}`. `/blueprint` returns its finished plan verbatim. A subsequent implementation is a new task with the plan and required context supplied explicitly.

## Lifecycle and result collection

`dispatch_agent` returns a stable session-local agent ID; an optional `batchId` groups tasks. `manage_agent` supports only:

- `status`: inspect task or batch state and available evidence.
- `wait`: collect results; a wait timeout only ends observation, not execution.
- `interrupt`: stop active work; inspect partial effects before another dispatch.
- `close`: stop/dispose the selected task or batch.
- `history`: 查询当前工作区跨重启保存的任务、结果和结构化校验，可按 `sessionId`、`agentId`、`batchId` 筛选，`limit` 默认 50、上限 100。

There is no `send`, `resume` or `rebase`, no interactive steering or second turn on an old child, and no automatic replay of historical tasks. New requirements or remediation require a new incremental task after checking existing file effects. `/agent` 和 `dispatch_agent` 不设执行超时，工具不再提供 timeoutMs 参数。旧调用携带的 timeoutMs 不会安装终止定时器。manage_agent.wait 的 timeoutMs 仅结束观察；终止任务使用 interrupt/close 或关闭会话。取消后的部分结果不等于成功。 Cancelling a parent wait does not itself cancel accepted work. The parent owns collection, outstanding-lane cleanup and final synthesis.

### 传输错误与重试

`controlled-pi` 子任务继承全局与项目配置中的 `retry` 策略，项目字段覆盖全局字段；不再强制关闭 SDK 重试。`terminated` 表示连接流异常结束，不代表工具或任务已回滚。可重试错误由 Pi SDK 在当前执行中续接；重试次数、延迟与错误分类由实际 Pi 版本决定，显式 `retry.enabled=false` 仍生效。

这不是重新派发整个任务，也不会加载 companion 恢复扩展或追加恢复提示。已完成工具的结果保留，但模型续接仍可发起新工具调用；不要把重试理解为副作用恰好执行一次的保证。执行期限与取消仍会中止 SDK 重试等待。

最终失败只记录一条回合诊断，保留可取得的助手文本作为部分证据；普通异常继续使用脱敏消息，明确的 `AgentStopError` 保留其错误原因。失败或超时均不算验收通过，后续派发前须核对已有文件效果。

Squash-enabled results return automatically. Every successful or failed result includes a parent handoff directive: address the original task explicitly in the next user-visible response, check evidence, and fill essential gaps or report them. Successful one-shot planning results retain the verbatim-plan directive. This is model guidance, not proof that the parent has accepted or answered the task.

The card label `已回传主线程，待汇总` records message receipt only; it does not certify a user-visible conclusion. No automatic “summarized” state is inferred from an unrelated parent answer. `squash=false` leaves a user-visible transcript entry without automatically injecting it into model context or triggering a parent turn; collect through explicit management. Memory children do not survive process restart; persisted result cards are not resumable workers.

## Permissions and validation

常规 scoped 模式：Writable dispatch requires an explicit `writeScope` within the project and the live parent `executeTool` approval bridge. Omit the scope for read-only work. Allowed builtin tools pass through parent validation/hooks/approval; 经来源验证的只读网页工具和 LSP 也可继承；其他自定义工具使用 fullTools 模式，递归派发不继承。 Overlapping active child write scopes reject. The parent must also coordinate its own writes. Missing writable capabilities fail explicitly rather than silently bypassing approvals.

Workers have no shell by default. `testCommands` authorizes exact command strings via parent hooks and requires a workspace-wide exclusive child lock. Approved repository code executes with host permissions: this is **not a filesystem or shell sandbox**. Read tools are not restricted to cwd; path guards do not defend against hostile concurrent filesystem mutation or hardlinks. Do not delegate untrusted execution on this basis.

`/agent` 通过主线程工具回合取得执行桥；`fullTools:true` 支持主线程已启用的自定义工具、网页、MCP、文件修改和任意命令，仍经过父审批。完整模式持有工作区独占子任务锁，递归派发工具不继承。未启用的父工具不会自动开启；此桥不是文件系统沙箱。其他旧命令上下文没有执行桥时仍仅支持读取。子任务不会独立加载自定义扩展。

## 结构化结果与历史

`dispatch_agent.outputSchema` 支持对象、数组、基础类型、required、enum/const、anyOf/allOf/oneOf/not、数值/长度/数量约束等可移植 JSON Schema 子集；`$ref`、format 等未支持关键字会在启动前明确拒绝。子任务最终返回 JSON，主线程在 `structuredResult` 取得 `valid/value/errors`。不符合约定会标记任务失败并保留原始结果，不重跑工具副作用。普通文本任务不受影响。

任务快照保存在 Pi agent 目录的 `task-history/<工作区哈希>/`，文件原子替换，按父会话和记录 UUID 隔离。`manage_agent action=history` 返回历史记录；存档里的未结束状态标记 `unknown_after_restart`，不恢复进程、不自动重跑。同一父会话重启后的重复 `user-N` 由记录 UUID 区分。归档写失败在管理结果 `historyError` 中披露。

## 语言服务

`lsp` 提供 `diagnostics/definition/references/hover/status`。`path` 限当前工作区，行列均从 1 开始，列按 UTF-16 计数。按需启动已安装的 typescript-language-server、pyright-langserver、clangd 或 rust-analyzer；也支持 `.pi/lsp.json`：

```json
{"servers":{"custom":{"command":"my-language-server","args":["--stdio"],"extensions":[".ext"]}}}
```

不会自动安装语言服务器；status 不启动进程。查询使用真实 JSON-RPC，支持文件同步、推送/拉取诊断、取消、15 秒请求上限及会话关闭时回收。提供只读查询，不执行语言服务器发起的 workspace/applyEdit。

## Compatibility boundary

Old upstream descriptions of inherited conversation snapshots, steering, multi-turn continuation, `/agent resume` and raw-history rebase are historical and do not describe this fork’s current contract. Existing historical data is not replayed. Legacy `pi-subagents` loading and supervisor/delegation tool aliases are blocked; unrelated custom packages are not disabled. This loading restriction is not an OS sandbox against malicious extensions.

For parser implementation details see [PARSER_SPEC.md](PARSER_SPEC.md); older parser/internal design notes may describe historical behavior and do not override the one-shot contract above.


## 批量派发与短角色模板

独立任务可用一次 `dispatch_agent({tasks:[...],batchId})` 并发启动，单批 1–6 个；各项保留独立 task、writeScope、testCommands、outputSchema 等字段。入站结果按原顺序返回各任务 ID 或失败原因，不等待子任务完成。部分启动失败不会重跑已启动任务。

可选 `role` 为 explorer（定位代码）、librarian（外部资料）、oracle（架构/诊断）、designer（界面）、fixer（定界实现）。角色只补充短任务指导，模型与思考级别沿用当前会话，权限仍由派发参数与父审批决定。无需固定凑齐角色。主线程策略优先一次批量发出已就绪独立任务，避免重复勘查、重复实施与轮询；完成结果继续从管理接口读取，不唤醒子模型。

## AST 编辑

`ast` 支持 JS、JSX、TS、TSX、mjs、cjs，使用固定版本 TypeScript 5.9.3 解析器。query 返回真实节点、源码、SHA-256、UTF-16 区间与行列；selector 使用 SyntaxKind 和可选 name/text/start/end。preview 返回修改后源码但不写入；apply 必须提供 expectedHash，经父 write 审批写入。展示 limit 不会截断编辑范围；重叠节点、旧哈希、原文件或替换后语法错误会明确拒绝。解析检查不等于类型检查或业务正确性验证。

## Node 调试器

`debugger` 可 launch/status、设置/删除文件断点、continue、step_over/step_into/step_out、pause、stack、scopes、evaluate、stop。使用 Node Inspector/CDP 和回环 WebSocket；仅支持 Node 脚本，不声称支持通用 DAP 或原生调试器。launch 在用户脚本入口暂停，跳过宿主预加载阶段的内部暂停；行列从 1 开始。表达式可在当前栈帧或全局执行。

脚本没有总运行期限。连接和单次协议请求有错误返回时限；status 查询状态，stop 或 session_shutdown 终止进程并释放连接。脚本/表达式会真实执行，沿用工具审批。stdout/stderr 为有界缓存，截断状态明确返回。
