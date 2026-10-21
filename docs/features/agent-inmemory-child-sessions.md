# /agent 子会话内存化（零落盘、不进 /resume）技术变更说明

### 问题

`/agent` 及其衍生命令（`/spawn`、`/blueprint`、`/scout`）每次派发都通过
`SessionManager.create(cwd, undefined, {parentSession})` 写入真实会话文件
（`~/.pi/agent/sessions/--<sanitized-cwd>--/<timestamp>_<sessionId>.jsonl`），导致：

- `/resume` 与 `pi -r` 列表被派发代理刷屏，与用户自己的会话混排（实测 AxumAgent 目录
  205 个会话文件中 66 个带 `parentSession` lineage）；
- 无法按 `parentSession` 字段过滤列表——`/new`、label、fork 同样写该字段
  （session-manager.js L657/L1105/L1265），字段语义不专属派发代理。

### 原因

子会话落盘没有运行时价值：其 transcript 仅由 widget / agent-viewer 在进程内消费，
进程结束即无用；生命周期广播、压缩、rebase squash、进程内续聊均为内存操作。
唯一落盘点是 runner.ts 两处 `SessionManager.create`。SDK 已提供
`SessionManager.inMemory(cwd)`（`new SessionManager(cwd, "", undefined, false, …)`，
session-manager.js L1225）：不建目录、不写文件、`_persist` 为 no-op，但
`getSessionId()` 照常生成、`appendMessage`/`persistMessages`/compaction 全接口兼容，
与 `create` 返回对象同构，可原位替换。

### 修改点

- `plugin/pi-agent/runner.ts`
  - 主派发点（原 L489）：`SessionManager.create(dispatch.services.cwd, undefined, {parentSession})`
    → `SessionManager.inMemory(dispatch.services.cwd)`，注释同步内存化语义。
  - `resumeOneFailedAgent` 的 redispatch 分支（原 L399）：同上替换。
  - `getFinalAssistantText` 调用（原 L896）：随 final-response API 收敛移除第三参数。
  - `findChildSessionFile` 注释更新：该函数仅服务存量（旧版本落盘）子会话的 continue 恢复。
- `plugin/pi-agent/final-response.ts`：三个错误类
  （`EmptyAgentTextError`/`NoAssistantMessageError`/`AgentStopError`）删除
  "full transcript resumable via /resume `<id>`" 假指引；sessionId 参数因失去用途移除；
  `getFinalAssistantText` 移除未用的 `agent` 参数。
- `plugin/pi-agent/shared.ts`：`AgentCommandDetails.sessionId` 注释改为
  "定位存量（pre-in-memory）子会话文件"；`RunningAgent.sessionId` 注释同步内存化语义。
- `plugin/pi-agent/widget.ts`：rebase 关闭兄弟行的注释措辞同步（resumable → detached）。
- `plugin/pi-agent/README.md`：9 处行为描述改写——Detach 章节（无文件可拾回）、
  "Agents stay out of your session list" 章节、`/agent resume` 章节（continue 仅对存量文件、
  `-p` 失败需重跑）、`/aclear` 说明。
- `test/pi-agent.test.js`：
  - 新增契约测试 "dispatched children run on in-memory sessions — no session file is ever
    written"：`inMemory` 不落盘断言 + persisted 对照证明目录布局假设 + runner 双创建点
    `SessionManager.inMemory(dispatch.services.cwd)` 出现次数回归守卫。
  - 8 处 `getFinalAssistantText` 调用移除第三参数；删除 `/resume session-9` 文案断言。

### 预期结果

- 派发子代理不再产生任何会话文件：`/resume` / `pi -r` 列表恢复干净（仅用户自己的会话），
  新会话文件不再携带 `parentSession`。
- 行为副作用（已确认接受）：
  - Detach（`d` `d`）后子代理 transcript 不可再找回（原可 `/resume` 续聊）；
  - `/agent resume`：新失败代理一律走 redispatch 分支（continue 路径仅对存量落盘文件生效）；
    `-p` plan-relay 失败代理跳过并提示重跑 `/agent -p`；
  - 会话 reload 后结果卡保留，活跃 transcript 不可恢复。
- 验证：`node --test test/pi-agent.test.js` 68/68 通过；全量 `npm test` 467/467 通过
  （历史基线 466 + 新增 1，零新失败）。
- 用户 UAT：真实会话中执行 `/spawn <task>`，确认 `~/.pi/agent/sessions/--<cwd>--/`
  无新文件、`/resume` 列表无新条目、代理行为与 widget 交互正常。
