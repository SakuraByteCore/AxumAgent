# 基线失败测试修复（9 例 + 1 例偶发）技术变更说明

### 问题
全量回归 `npm test` 存在 9 个基线既有失败测试（与 agentui 面板任务无关的历史遗留）：
- `test/pi-header.test.js` 3 例（welcome 块 skills 行缺失、`/pi-debug` 不在 commands 行、宽度 50 折叠断言）
- `test/pi-companion.test.js` 2 例（plan 命令英文/CJK 内置模板断言）
- `test/pi-agent.test.js` 4 例（`/spawn` `-s`、`/scout` `-i`、`/blueprint` `-P -s` 前缀、preset 空参数告警）
另有 1 例 `auto-compact proof arriving after agent_settled still resumes` 间歇性失败（此前误判为满负载偶发）。

### 原因
逐组诊断结论（均有工具输出证据，非测试盲改）：

1. **pi-header 3 例 — 测试与实现演进脱节**：commit `12ddb56`（对齐标签 padEnd）与 `7470c28`（skills/context/extensions 改经内核快照 `globalThis.__axumLoadedResources` 渲染、标签列宽 8→10）两次刻意变更均未同步更新测试。实际渲染头行为 `" commands  : "`（12 字符）、续行缩进 13 空格，而测试过滤器仍匹配旧格式 `" commands: "` / 11 空格；skills 行在测试环境下因无人写快照全局而缺失。经 git 历史比对 `dafbcaa` 时刻的渲染实现（infoLabelWidth=8、skills 来自 `detectSkills` 探测缓存），确认测试编码的是旧契约，实现为权威方。
2. **plan 2 例 — 测试不密封（环境泄漏）**：plan 命令运行时读取 `~/.pi/agent/plan-prompt.md` 用户模板；开发者本机存在自定义「前置真调研」模板，非密封测试读取到真实 HOME 下的模板，遮蔽了内置默认模板断言。
3. **preset 4 例 — deps 契约演进未同步 mock**：commit `5c25d03` 给 `PresetDeps` 增加 `disabledCommands`（命令自动移除特性），测试 mock `createPresetDeps` 未补该字段，`registerPresets` 处理器首行 `deps.disabledCommands.has(...)` 即抛 `TypeError`。
4. **auto-compact 1 例 — 测试间 env 泄漏竞态（真实缺陷）**：`process.env.PI_COMPANION_COMPACT_PROOF_TIMEOUT_MS = "20"` 位于模块作用域（原 test 文件 L760），模块加载即生效；排在其后的 646 号测试在 20ms proof 超时竞态下运行——若测试的 `onComplete` 晚于 20ms 定时器触发，proof 已超时拒绝且 `turnWasActive=false` 无补偿 resume，消息永不发出。失败率约 50%，与负载相关。诊断证据：失败现场通知为 `Auto-compact failed: compaction proof timeout`；10s 预算下仍复现，排除「设备停摆」假设。

### 修改点
全部为测试侧修复，`plugin/` 与 `src/` 源码零改动：

- `test/pi-header.test.js`
  - `renderHeaderLines` 增加可选 `loadedResources` 参数：渲染前写 `globalThis.__axumLoadedResources`、finally 清除，模拟内核补丁（`src/bundled-pi-patches.js`）在运行时的快照写入；新增 `LOADED_RESOURCES` 快照常量（context/skills/extensions）。
  - 新增 `commandInfoLines` 匹配器：头行 `" commands  : "`、续行 13 空格缩进，替换 tests 1/2 的旧格式过滤器；test 3 的 `startsWith("commands: ")` 改为对齐格式 `startsWith("commands  : ")`。
  - tests 1/3 传入快照使 skills 标签行在场，test 3 的 `labelCols` 三标签冒号同列断言（均为第 12 列）随对齐实现通过。
- `test/pi-companion.test.js`
  - 新增 `withBareHome(fn)` 密封 HOME 辅助（mkdtemp 空目录 + finally 还原），包裹「plan-first prompt」与「CJK no-code rules」两例，阻断真实用户模板泄漏。
  - `PI_COMPANION_COMPACT_PROOF_TIMEOUT_MS="20"` 从模块作用域移入「proof timeout resumes」测试体内并加 try/finally 清理：env 仅在该测试执行期间生效，前置 auto-compact 测试回到默认 300s proof 超时，竞态确定性消除。
- `test/pi-agent.test.js`
  - `createPresetDeps` mock 补 `disabledCommands: new Set()`。
  - 新增 1 例测试「preset command disabled by auto-removal notifies and does not launch」覆盖 `5c25d03` 特性的 disabled 通知路径（此前无覆盖）。

### 预期结果
- `npm test` 465 例 / 465 过 / 0 失败（原 464 例 + 新增 1 例）。
- auto-compact 竞态消除验证：`--test-name-pattern="auto-compact"` 连续 6 轮 6/6 全过（修复前同口径约 50% 失败）；`test/pi-companion.test.js` 全文件连续 2 轮 60/60。
- 测试不再依赖开发者真实 HOME（plan 模板）与测试间 env 泄漏，任何环境执行结果一致。
- 无源码改动，无需重编译 bundled pi 缓存；运行时行为零影响。
