# Provider Web 原生支持 OpenAI Responses API 技术变更说明

### 问题

AxumAgent 的 pi 引擎原生支持 `openai-responses`（`pi-ai/dist/api/openai-responses.js` 与 `BUILTIN_APIS` 注册在案），但 Provider 设置 UI 将协议形态锁定为 `openai-completions` / `anthropic-messages` 两种：`API_FORMS` 缺少 Responses 条目、`normalizeApiForm` 对未知 api 抛错、前端 `setApiForm` 将未知值静默回退为 `openai-completions`、后端 `/api/models` 白名单拒绝 Responses 形态。用户此前只能手工编辑 `~/.pi/agent/models.json` 写入 `"api": "openai-responses"`，且一旦在 Web UI 重新保存即被改写丢失。

### 原因

- 事实：pi 运行时 `provider-composer.js` 的 `modelFromJson` 接受任何已注册 api id，无白名单；瓶颈完全在 AxumAgent 配置层。
- 事实：前端 `/api/models` 请求体不携带 api 字段，模型拉取走 `/v1/models`（Responses 与 Chat Completions 共用同一列表端点）。
- 推论：只需在配置/UI 层放开该形态并保证未知 api 原值透传，即可完整打通，无需触碰 pi 引擎。

### 修改点

按用户确认的方案 B / A / A 实施：

1. `src/provider-config.js`
   - `API_FORMS` 新增 `{ id: "openai-responses", labelKey: "apiShapeOpenAIResponses", fetchable: true }`。
   - `PROVIDER_PRESETS` 新增 `openai-responses` 预设（baseUrl `https://api.openai.com/v1`、contextWindow 128000、maxTokens 16384、候选 `gpt-5`/`gpt-4.1`）。
   - `normalizeApiForm` 由"未知值抛错"改为"非空原值透传、空值回退默认"（移除 `KNOWN_API_FORMS`），保证 models.json 中手写 api 值在 UI 重新保存时不被覆盖。
2. `src/provider-web.js`
   - 协议下拉静态 HTML 增加 `openai-responses` 选项。
   - 前端 `setApiForm` 改为未知 api 原值透传：动态追加 `data-custom` 下拉项显示原文，不回退改写；已知形态时清除残留自定义项。
   - `updateApiFormUi` 改为 undefined-safe（`form?.fetchable ?? false`），未知形态禁用可用性测试按钮并提示。
   - 后端 `/api/models` 门禁由单一 `openai-completions` 放开为 `openai-completions` 与 `openai-responses`。
   - i18n 三语（en/ja/zh）补齐 `apiShapeOpenAIResponses`、`presetOpenAIResponses`，并更新 `testUnsupportedForm` 文案覆盖 Responses 形态。
3. `test/provider-config.test.js`、`test/provider-web.test.js`（对称回归断言同步）
   - 未知 api 断言由 `assert.throws(/Unsupported API form/)` 改为透传等值断言。
   - 预设清单断言纳入 `openai-responses`。
   - `/api/models` 拒绝文案正则同步更新。

### 预期结果

- 验证依据：`node --check` 语法通过；`npm test` 全量 **501 pass / 0 fail**（12.6s）；`buildProvider` 冒烟验证 `openai-responses` 落盘、未知 `custom-gateway` 透传、空值回退 `openai-completions` 均符合契约。
- 运行状态：Provider 页可选 OpenAI Responses 协议与预设；保存后 `api` 原值写入 models.json；Fetch/测试按钮对 Responses 形态可用。
- 构建命令：`npm test`（node --test test/*.test.js）。
- 清理记录：无中间产物产生。
