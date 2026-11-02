# E2E 测试文件补齐

### 问题

仓库当前只有一个 E2E 文件 `test/e2e.test.js`，原有 3 个场景存在覆盖与真实性缺口：

- 仅覆盖根级 `code --help`、`code --safe --help` 与 `/plan`。
- CLI 场景未隔离 `HOME`、Pi 配置目录及 Bundled Pi 缓存，缓存缺失时可能触发真实 npm 安装与网络访问。
- `--safe` 场景只检查 stdout，无法拦截实际写入 stderr 的首装信息。
- `/plan` 场景内联复制了一份过期处理器，没有加载 `plugin/pi-companion/index.ts` 的真实实现。
- 缺少 `doctor`、MCP 完整生命周期、MCP 错误路径、离线版本信息及 `bin/code.js` 快捷入口。

### 原因

- E2E 测试只建立了最小 `spawnSync` 辅助函数，没有统一隔离用户状态、运行目录和 Bundled Pi fixture。
- 扩展命令测试复制业务逻辑而非加载生产扩展，导致生产提示词、模板读取和错误处理漂移后仍可假通过。
- 仓库已有 `test/cli.test.js` 的 fake cache 思路，但 E2E 文件未复用相同的隔离契约。

### 修改点

- `test/e2e.test.js`
  - 建立统一临时沙箱：隔离 `HOME`、`USERPROFILE`、`XDG_CACHE_HOME`、`XDG_CONFIG_HOME`、`PI_CODING_AGENT_DIR` 与用户扩展清单。
  - 建立完整 fake Bundled Pi fixture，覆盖 Pi CLI、TUI、运行时依赖、User-Agent、TypeScript 与 8 个 Windows 扩展入口；测试不访问网络且不安装真实 npm 包。
  - 为所有 CLI 子进程设置 180 秒进程级超时。
  - 覆盖根帮助、离线版本信息、`doctor`、`code`、`code --safe`、`bin/code.js`、非法 Web 端口。
  - 覆盖 MCP 空配置、`add/list/remove` 落盘往返、usage/install notice、未知子命令和删除错误。
  - 直接加载真实 `plugin/pi-companion/index.ts`，覆盖 `/plan` 内置提示词、用户模板覆盖、空需求拒绝及 `deliverAs:"followUp"`。
  - `--safe` 安装输出断言同时覆盖 stdout 与 stderr。

### 预期结果

- 仓库唯一 E2E 文件提供 14 个可重复、离线、隔离的端到端场景。
- CLI 测试不再依赖开发机真实 HOME、配置或 Bundled Pi 缓存状态。
- 扩展命令测试直接绑定生产实现，不再维护复制版 handler。
- MCP 配置生命周期与错误路径均由真实 CLI 子进程验证。

### 验证证据

- `node --test test/e2e.test.js`：14 通过、0 失败、0 跳过。
- `node --test test/e2e.test.js test/cli.test.js test/pi-companion.test.js`：148 通过、0 失败、0 跳过。
- `npm run build`：通过。
- `git diff --check`：通过。
- `node --check test/e2e.test.js`：通过。
- `npm test`：678 例，652 通过、19 失败、7 跳过；本次 E2E 14 例全部通过。19 个失败均位于未改动的 `test/provider-web.test.js` 与 `test/fast-web-control.test.js`，表现为真实 HTTP 403 与 `apiFetch is not defined`，不属于本次 E2E 文件变更。
- 只读审计子代理 `user-2` 完成并定位上述缺口；`user-3` 因上游 HTTP 400 `Invalid request` 未产出结论，扩展/Web/Chat/Code 可测性结论由主线程本地取证补齐。
- 本次提交仅包含本任务测试与归档；工作区原有文档修改与未跟踪文件保持原状。
