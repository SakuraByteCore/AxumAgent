# 新用户开箱即用：默认关闭 pi-subagents 异步子代理状态行 技术变更说明

### 问题
pi-subagents 的 under-editor 异步 widget 会在后台子代理运行时于输入框下方渲染
`async subagent worker · background` 标题行（`src/tui/render.js` 组合：
`async subagent${mode} · background`）。对新用户而言该行信息密度低、突兀，
要求移除，且新用户开箱即用（无需手动改配置）。

### 原因
- pi-subagents 提供原生 opt-out 开关：`config.asyncWidget !== false`
  （`src/extension/index.js`），配置文件为
  `~/.pi/agent/extensions/subagent/config.json`（其 `getAgentDir()` 语义：
  `PI_CODING_AGENT_DIR` 支持 `~`/`~/x` 展开，缺省 `~/.pi/agent`）——
  观测事实，无需改动上游 npm 包。
- axum 发行版已有"首启播种默认值"机制：`ensureTuiModeDefault` /
  `ensureWebSearchWorkflowDefault`（`src/provider-config.js`，仅在键缺失时
  填充，显式配置永远优先，坏 JSON 不覆盖）。照此模式播种
  `asyncWidget: false` 即可让所有新用户首启即得干净状态区。

### 修改点
- `src/provider-config.js`：新增 `getSubagentConfigPath(env)`（expandTilde
  语义与 pi-subagents getAgentDir 对齐）与 `ensureSubagentAsyncWidgetDefault(file)`
  （键缺失播种 `asyncWidget: false`；unparseable JSON 时跳过不覆盖）。
- `bin/axum.js`：`runPi()` 引导链在 `ensureWebSearchWorkflowDefault()` 后
  追加调用 `ensureSubagentAsyncWidgetDefault()`。
- `test/provider-config.test.js`：按 web-search 三联样式新增三用例
  （缺文件播种 / 保留既有键补缺 / 显式值不覆盖），另入导入 `getSubagentConfigPath`。
- 本机即时生效：直接播种 `~/.pi/agent/extensions/subagent/config.json`
  （内容直读验证 `{"asyncWidget": false}`）；发行版侧待 push main 后由
  `axum update` 拉取，使全新安装的新用户首启自动播种。

### 预期结果
- 后台子代理运行时，输入框下方不再出现 `async subagent worker · background`
  标题行及其展开树（widget 整体关闭）；`/subagent`、fleet 视图等其余功能不受影响。
- 已显式设置 `asyncWidget` 的老用户配置不被触碰（幂等，键存在即跳过）。
- 验证：`node --test test/provider-config.test.js` 47/47；`npm test` 501/501
  全绿；本机配置文件播种结果已内容验证（事实观测）。
