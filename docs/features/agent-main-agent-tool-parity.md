# /agent 与主 Agent 工具能力对齐

### 问题

`/agent` 已通过 `fullTools:true` 复用主线程的模型、Provider、认证、项目设置、重试策略、工作目录和父工具审批桥，但子任务工具上限仍复用一个过宽的委派黑名单。黑名单同时排除了 `dispatch_agent`、`manage_agent`、`orchestrate`、`quick` 和 `agent`，导致 `/agent` 实际能力并未达到“除不能在 `/agent` 内再次分发 `/agent` 外，其余父能力均相同”的目标。

### 原因

- `plugin/pi-agent/permissions.ts` 使用 `DELEGATION` 集合同时处理工具上限与父桥代理，导致不创建子代理的生命周期/管理工具也被一并移除。
- `/agent` 的 `fullTools:true` 契约已要求继承全部启用父工具，工具实现与该契约不一致。
- 单元测试只断言 `dispatch_agent` 被排除，没有断言 `manage_agent` 等非派发工具仍可用。

### 修改点

- `plugin/pi-agent/permissions.ts`
  - 将子任务禁用集合收窄为仅 `dispatch_agent`。
  - `inheritedToolCeiling` 继续阻断 `dispatch_agent`，其余启用父工具按既有 full/scoped 规则进入子任务。
  - `bridgedChildTools` 同样只阻断 `dispatch_agent`，其余父工具继续通过 live parent approval bridge 执行。
- `plugin/pi-agent/dispatch.ts`、`plugin/pi-agent/index.ts`、`plugin/pi-agent/runner.ts`
  - 统一命令、参数、能力提示文案：明确仅排除 `dispatch_agent`。
- `plugin/pi-agent/README.md`
  - 更新 `/agent` 与权限契约，明确 `manage_agent` 等其余父工具保持可用。
- `test/pi-agent-alignment.test.js`、`test/axum-auto-permissions.test.js`、`test/pi-agent-management.test.js`
  - 覆盖 fullTools 下 `manage_agent` 保留、`dispatch_agent` 即使显式请求也仍被拒绝。
- `test/pi-agent-production-integration.test.js`
  - 真实 SDK 父会话中验证子任务工具清单包含 `manage_agent`、不包含 `dispatch_agent`，并实际调用 `manage_agent`。

### 预期结果

- `/agent` 子任务继承主 Agent 当前启用的全部父工具，包括文件、命令、网页、MCP、自定义工具及 `manage_agent`。
- `/agent` 子任务内无法调用 `dispatch_agent`，不能创建孙级任务。
- scoped `dispatch_agent` 的既有权限边界不变；模型、Provider、认证、设置、重试策略与独立一次性上下文契约保持不变。

### 验证证据

- `node --test test/pi-agent-alignment.test.js test/axum-auto-permissions.test.js test/pi-agent-management.test.js`：22 通过、0 失败、1 跳过。
- `AXUM_INTEGRATION_NODE_MODULES=/data/data/com.termux/files/home/.cache/axum-agent/bundled-pi/v4/android-arm64/pi-3fd68d13d08f/node_modules node --test test/pi-agent-production-integration.test.js`：1 通过、0 失败。
- `AXUM_INTEGRATION_NODE_MODULES=/data/data/com.termux/files/home/.cache/axum-agent/bundled-pi/v4/android-arm64/pi-3fd68d13d08f/node_modules node --test test/pi-agent*.test.js`：133 通过、0 失败、2 跳过。
- `git diff --check`：通过。
- `npm run build`：通过。
- TypeScript LSP：环境缺少 `typescript-language-server`，未取得 LSP 诊断；已用 `node --check` 覆盖修改的 TypeScript 文件语法。
- 探索子代理：因上游返回 HTTP 400 未产出结论；本轮定位、修改与验证证据均来自主线程本地取证。
- 本次提交仅包含本任务代码、测试与归档；工作区原有 `docs/` 修改与未跟踪文件保持原状。
