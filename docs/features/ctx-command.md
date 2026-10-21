# /ctx 上下文长度命令 + Web 移除 Context length 字段 技术变更说明

### 问题
会话内没有任何命令可直接查看/修改当前模型的 contextWindow，只能走 `npm run web` 的 provider 级整批表单且需重启会话才生效；与"像 /plan 一样一条命令搞定"的诉求不符。

### 原因
- 事实观测：`/plan` 命令注册于 `plugin/pi-companion/index.ts`（`pi.registerCommand`）；`ctx.model` getter 返回的就是 `agent.state.model` 存储的同一对象引用，且 pi-coding-agent 的上下文计量/压缩判定均实时读取 `model.contextWindow`——原位改写即可立即生效，无需 setModel 或重启。
- 事实观测：Web 端 "Context length" 的 HTML 字段、三语 i18n、`bindTokenField/setTokenField('contextWindow')`、save payload 与 `/api/save` 服务端映射全链路集中在 `src/provider-web.js`。

### 修改点
1. `plugin/pi-companion/index.ts`
   - 新增 `rename` 导入（node:fs/promises，用于原子持久化）。
   - 注册 `/ctx` 命令：无参 → notify 显示 `provider/model: contextWindow = N`；正整数参数 → `ctx.model.contextWindow = N` 原位改写（会话立即生效）+ 原子改写 `~/.pi/agent/models.json` 当前 provider 块内当前 model 条目（临时文件 + rename）；非法参数 → warning notify 退出，不写任何文件；模型不在 models.json 内 → 仅会话生效并显式告知未持久化。
   - 辅助函数 `parseContextWindowArg`（正整数校验）与 `findPersistedModelEntry`（models.json 条目定位）。
2. `src/provider-web.js`
   - 移除 HTML 字段块（`input#contextWindow` + label/hint）、en/ja/zh 三语 `contextLength`/`contextWindowHint` i18n 键、全部 `bindTokenField('contextWindow')`/`setTokenField('contextWindow',…)` 调用（applyPreset/fillProvider/newProviderForm/applyModelTokenFields/初始化）、save payload 中 `contextWindow:providerLastValid.contextWindow`、DEFAULTS 注入模板中的 `DEFAULT_MODEL_CONTEXT_WINDOW`；`maxTokens` 全链路原样保留。
   - `/api/save` 服务端映射修正：请求体不再携带 contextWindow；编辑已有 provider（按 `originalName`/`name` 定位）时逐模型保留 models.json 现存 contextWindow，条目缺失或新建 provider 回退 `DEFAULT_MODEL_CONTEXT_WINDOW = 128000`。防止"编辑现有 provider 时把 /ctx 调好的上下文长度静默重置"。
3. `test/provider-web.test.js`
   - 既有 save 断言同步为"新 provider 默认 128000"；非法输入用例由 `contextWindow: 0` 改为 `maxTokens: 0`（覆盖 `/Max output tokens must be a positive number/`）；克隆保真用例改为 save 后手工改写 models.json 模拟 /ctx 调参再克隆断言。
   - 新增专项用例 "provider web edit preserves each model's on-disk contextWindow"：新建 → 模拟 /ctx 调 999000 → 重新保存同 provider → 断言 mock-b 保持 999000、mock-a 保持默认 128000。
4. `test/prompt-history-dom.test.js`：DEFAULTS 注入串替换模板同步为仅 maxTokens。
5. `test/pi-companion.test.js`：新增 `/ctx` 四用例（无参查询/原位改写+持久化+原子 rename 无残留/非法参数拒写且 models.json 零变动/模型缺失时仅会话生效）。

### 预期结果
- 会话内 `/ctx` 可查询，`/ctx <N>` 立即生效并持久化，重启后仍保持；非法输入零副作用。
- `npm run web` 提供商编辑页不再出现 "Context length" 字段；编辑保存现有 provider 不再重置各模型已调好的 contextWindow；新建 provider 默认 128000。
- 全量回归：`npm test`（node --test test/*.test.js）490/490 通过；`node --check src/provider-web.js` 通过。
- 复现验证：`axum code` 启动（指纹机制自动同步插件源）→ `/ctx` → `/ctx 200000` → `cat ~/.pi/agent/models.json`；`npm run web` 打开提供商编辑页确认字段已移除。
