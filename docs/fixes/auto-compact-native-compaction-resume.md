# [pi-companion 自动压缩后续跑] 变更说明

### 问题

用户反馈：任务在自动压缩之后必定停住，必须手动输入「继续」才能继续推进。

会话日志（`~/.pi/agent/sessions/--storage-emulated-0-yun-other-9-红果短剧--/2026-10-31T12-52-48-808Z_01a19205-1425-776a-99c7-f5574850a477.jsonl`）中反复出现同一模式：

- 行 @432：助手回合 `stopReason=error`，`400: {"message":"Invalid request","type":"invalid_request_error"}`，`tokensBefore=230219`；其后是压缩条目，再由用户手打「继续」。
- 行 @579 / @717 / @860 / @904：助手回合 `stopReason=aborted`，`Operation aborted`（压缩 abort 掉在飞回合），同样由用户手打「继续」接力。
- 对照组：本仓库 AxumAgent 会话在压缩后自动出现用户消息 `Continue the active task using the continuation handoff summary above.`，说明 pi-companion 的 ledger 压缩续跑链路本身可用。

### 原因

两个结构性缺口叠加，缺一不会停摆：

1. **双重压缩冲突吞掉续跑**。Pi 运行时（`dist/core/agent-session.js`）在 `_handlePostAgentRun()`（行 1363）内先执行 `_checkCompaction()` 触发原生阈值压缩，再在行 1383 发出 `agent_settled`。pi-companion 的 `maybeCompact()` 在 `agent_settled` 时按软阈值（75%）再次发起压缩，但原生压缩没有写入 `lastCompactAt`，冷却窗口拦不住它；于是 `ctx.compact()` 撞上 pi 的 `AgentSession.compact()`，对已压缩分支抛 `Already compacted`。此时 `resumeAfterNativeCompaction()` 因 `pendingCompact` 已置位而提前返回，压缩失败的 catch 分支又要求 `turnWasActive`（此刻会话已空闲、为 false）才补兜底提示，两条路都不发续跑提示。
2. **忙态早退不再挂定时器**。`drainCompactResume()` 在 `!ctx.isIdle()` 或 `ctx.hasPendingMessages()` 时直接 `return`，而重试定时器只在真实发送后才由 `scheduleCompactResumeRetry()` 排下一次；`compactResumePending` 永远为真却无人再触发，续跑提示被静默丢弃。

附带缺口：`session_compact` 处理器原先只在 `lastAssistantMessage?.stopReason === "error"` 时置 `nativeCompactionStalled`，压缩发生后才被清空的状态读不到，判定容易漏。

### 修改点

全部改动集中在 `plugin/pi-companion/index.ts`：

- `session_compact` 处理器：原生压缩（非 `manual`）写入 `lastCompactAt`、置 `compactedByPi`，并快照 `nativeCompactionStopReason`；`fromExtension`（摘要由别的扩展提供）只记录状态、不接管续跑。
- `maybeCompact()`：新增 `compactedByPi` 短路——pi 刚压缩过就不重复压缩，避免 `Already compacted`；占用回落到阈值以下时清除该标记。
- `resumeAfterContextError()`：`compactedByPi` 或冷却窗口命中时不再二次压缩，只补发中性兜底提示；压缩失败时用 `COMPACT_RESUME_FALLBACK_PROMPT` 而非声称存在 ledger 摘要。
- `resumeAfterNativeCompaction()`：停止原因改用压缩瞬间的快照 `nativeCompactionStopReason`，不再依赖可能被清空的 `lastAssistantMessage`。
- `drainCompactResume()`：忙态不再静默丢弃——计入 `compactResumeBusyPolls`（不消耗发送次数预算）并重新挂载重试定时器；超过 `COMPACT_RESUME_BUSY_MAX_POLLS_DEFAULT=240`（约 6 分钟，可用 `PI_COMPANION_COMPACT_RESUME_BUSY_MAX_POLLS` 覆盖）后停止轮询并提示一次，等待下一次 settle 事件接力。
- `startLedgerCompaction()` catch 分支：只要存在待发续跑就重新 drain，保证重试定时器被挂上；压缩成功后清除 `compactedByPi`。
- `message_end` 用户消息分支：任何用户消息（含自动续跑提示本身）清空待发续跑，避免用户已手动继续后又冒出一次重复续跑。

### 预期结果

- pi 原生压缩打断回合后，任务自动续跑，不再需要手打「继续」。
- 压缩失败、压缩与扩展压缩撞车时，续跑提示仍会送达。
- 用户手动接管后，不会再收到重复的自动续跑提示。

### 验证

- `node --test test/pi-companion.test.js` → 112 通过 / 0 失败（新增 4 条回归用例）。
- 回归用例在修复前全部失败（对旧代码 `git checkout` 后运行：4 fail / 0 pass），修复后全部通过，确认用例真正覆盖缺陷。
- `npm test` → 与基线同一失败集合（详见「验证」小节后的基线对比）。
- `npm run build` 通过；`git diff --check` 无空白错误。

新增回归用例（`test/pi-companion.test.js`）：

1. `a native compaction above the soft threshold resumes without a second compaction`：占用 80% 时原生压缩后不再发起第二次压缩，且回合被自动续跑。
2. `a pending resume survives a busy session and is delivered once idle`：会话繁忙时待发续跑保持挂起，空闲后自动送达。
3. `a failed compaction while the turn is active still resumes the task`：压缩失败（`Already compacted`）时回合仍被续跑。
4. `a user message cancels the pending auto-resume`：用户消息接管后不再产生第二次自动续跑。

### 证据

- **观测事实**：上述会话日志行号与 `stopReason`/`errorMessage`/`tokensBefore` 取值；pi 0.99.2 运行时 `agent-session.js` 中 `_handlePostAgentRun()`（行 1363）先于 `_emitAgentSettled()`（行 1383）、`AgentSession.compact()` 首行 `await this.abort()`；本仓库会话的压缩摘要为 `## Active task`（pi-companion ledger）时自动续跑，失败样本摘要为 `## Goal`（pi 原生压缩）。
- **确定推导**：原生压缩先于 `agent_settled` 发生 ⇒ 扩展在同一 settle 发起第二次压缩 ⇒ pi 对已压缩分支抛 `Already compacted` ⇒ 原生续跑判定被 `pendingCompact` 抑制、catch 兜底又被 `turnWasActive=false` 抑制 ⇒ 无提示发出。
- **分析推论**：`drainCompactResume()` 忙态早退且不排定时器 ⇒ `compactResumePending` 永为真且无触发者 ⇒ 任务在压缩后永久静默（静态代码路径推导，非运行时观测）。
- **未知盲区**：用户现场会话中原生压缩与 `agent_settled` 的实际毫秒级间隔无法从日志直接读出（间隔由 pi 运行时源码顺序推定）；`ctx.compact()` 在真实宿主中的 `Already compacted` 文案以 pi 0.99.2 源码与测试桩为准，未在真机复现。
