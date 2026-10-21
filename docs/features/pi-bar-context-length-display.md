# pi-bar Context length 显示与动态刷新 技术变更说明

### 问题
pi-bar 的 `context-tokens` 段在会话首请求前（usage 未知）显示 "0.0k" 占位符，无信息量；且 `/ctx` 修改 contextWindow 后 pi-bar 需等下一轮 turn 才刷新，不满足"支持动态变化"。

### 原因
- 占位分支（pi-bar `emitContext`）在 `tokens == null` 时固定发 `fmtTokens(0)` → "0.0k"；
- pi-companion `/ctx` 原位改写 `model.contextWindow`，不调用 setModel、不产生任何 pi 生命周期事件，而 pi-bar 的 `model_select` 处理器原先只刷 model/thinking 两段，不重算 context。

### 修改点
- `plugin/pi-bar/index.ts` `emitContext`：改为常驻双值显示 `已用/窗口`（如 "12k/200k"）；tokens 未知时仅显示窗口值（Context length，如 "200k"）；无模型（usage 整体缺失）时清除该段（`text: undefined`），彻底移除 "0.0k" 占位。
- `plugin/pi-bar/index.ts` `model_select` 处理器补 `emitContext(ctx)`：模型切换窗口差异即时反映。
- `plugin/pi-bar/index.ts` 事件总线新增监听 `pi-companion:context-changed` → `emitContext(currentCtx)`：`/ctx` 改写后同一命令周期内刷新。
- `plugin/pi-companion/index.ts` `/ctx` 定义 `CONTEXT_CHANGED_EVENT = "pi-companion:context-changed"`，在 `model.contextWindow = next` 原位写后立即 `pi.events.emit`（会话值已变即广播，持久化失败也不影响刷新）。
- `test/pi-bar.test.js`：既有 gauge 测试断言更新为双值文本；新增 "context-tokens shows used/window with no 0k placeholder"、"context pills refresh on /ctx changes and model switches without waiting a turn" 两用例。
- `test/pi-companion.test.js`：set/unpersisted 两用例断言事件已发；invalid 用例断言拒绝输入不发事件。

### 预期结果
- 首请求前 pi-bar 显示当前窗口（如 "200k"）；有 usage 后显示 "已用/窗口" 双值；无模型会话该段隐藏，不再出现 "0.0k"。
- `/ctx 200000` 执行后 pi-bar context-tokens 与百分比立即按新窗口重算；`/usemodel` 切换模型后同理。
- 验证：`node --test test/pi-bar.test.js test/pi-companion.test.js` 106/106 全绿；`npm test` 492/492 全绿（事实观测）。
- 实施过程临时补丁脚本（~/work/axum-scratch/*.py）已即时物理删除。
