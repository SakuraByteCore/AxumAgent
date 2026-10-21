# /resume 列表末条需求显示与选中预览 技术变更说明

### 问题
`/resume` 会话列表行显示会话开头第一条消息，长会话中该行长期陈旧；且选中某行后无法在不打开会话的情况下查看该会话最后的需求内容。

### 原因
上游 pi `buildSessionInfo`（session-manager.js）流式扫描 JSONL 时仅记录 `firstMessage`；行渲染 `displayText = session.name ?? session.firstMessage`（session-selector.js:390），无末条用户消息字段；主屏 TUI 无鼠标上报机制，真 hover 在触屏环境无事件源。

### 修改点
- `src/bundled-pi-patches.js` 新增两个软守护补丁（drift 即跳过、幂等标记）：
  - `patchPiSessionLastUserMessage`：`buildSessionInfo` 同一遍流式扫描内追加收集 `lastUserMessage`（仅 user 角色、后写覆盖前写），返回对象新增 `lastUserMessage: lastUserMessage || undefined`，零额外 I/O。
  - `patchPiSessionSelectorLastUserPreview`：行文本改 `name ?? lastUserMessage ?? firstMessage`；pi-tui 导入补 `wrapTextWithAnsi`；列表下方新增选中会话末条用户消息的 muted 预览区——控制字符归一化后按 `width-2` word-wrap，上限 6 行、超出以 "…" 收尾；随方向键移动高亮行即时跟随（选中即预览，触屏等价于 hover 查看）。
- `applyBundledPiPatches` 注册两文件补丁（existsSync 软守护）；导出面同步追加。
- `test/bundled-pi-patches.test.js` 新增 4 用例：字段收集+幂等、drift 跳过、行链+预览块注入+幂等、drift 跳过。

### 预期结果
- 未命名会话行显示最后一条用户需求（单行截断），命名会话仍显示命名；预览区实时跟随选中行；纯助手/无用户消息会话回退 firstMessage 显示且无预览块。
- 验证（事实观测）：单测 34/34（含既有）、全量 `npm test` 496/496 全绿；实机缓存原位补丁后 `node --check` 通过、幂等复跑 0 改动；功能级渲染 harness 8/8 断言通过（短消息单行预览、6 行+省略号封顶、宽度不越界、legacy 无预览、行文本链正确）。
- 实机缓存 `pi-b3034b7ad9a6` 已原位应用本补丁（与 `axum code` 启动路径同效），用户下次重启 `axum code` 即生效，无需等待上游发布；仓库内改动经 push + `axum update` 后对新缓存长期生效。
- 未知盲区：真机 TUI 内 `/resume` 交互（搜索框占用首行、预览区挤压 maxVisible=10 的列表可见行数）未上机实测。
