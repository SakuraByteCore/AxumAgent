# provider-web 模型可用性测试真实请求化 技术变更说明

### 问题
`npm run web` 中 "Test availability"（测试可用性）按钮原判定逻辑为 GET `/models/{model}` 探针短路：网关对任意路径返回 2xx 时直接判 ok，完全不发对话请求，且仅看 HTTP 状态码不校验响应体，导致聚合网关场景下大量假阳性（显示 ✓ 但模型实际不可用）。

### 原因
- 观测事实：`testModelAvailability`（原 :29-61）第一步 GET `/models/{model}`，2xx 即短路返回 `ok:true`；
- 观测事实：回退 POST `/chat/completions` 仅校验状态码，不解析响应体（"HTTP 200 + error body" 假阳性）；
- 观测事实：`/api/models/test` 处理器（原 :216）用 `Promise.all` 全模型并发，限流型网关下易触发 429 造成误判 ✗。

按用户确认的推荐方案（1A / 2A / 3A）实施：真实请求 + 双校验；维持 `ping + max_tokens:1` 不重试；仅覆盖 openai-completions 形态（Anthropic 形态明示不支持），并发限 3。

### 修改点
- `src/provider-web.js`（服务端）
  - `testModelAvailability` 重写：移除 GET 探针短路，每模型必发真实 `POST {baseUrl}/chat/completions`（`messages:[ping]`、`max_tokens:1`、`stream:false`、20s 超时）；双校验 = HTTP 2xx 且响应体 JSON 含 `choices` 数组才判 ok；失败 detail 记录网关原因（`HTTP {status}` / `response missing choices array` / 异常消息）。
  - 新增 `testModelsBatch`：并发池限 3（`TEST_CONCURRENCY`），替代原 `Promise.all` 全并发。
  - 新增常量：`TEST_TIMEOUT_MS=20000`、`TEST_CONCURRENCY=3`、`TEST_PROBE_MAX_TOKENS=1`、`MISSING_CHOICES_DETAIL`。
- `src/provider-web.js`（前端内嵌 HTML/JS）
  - `renderTestList`：✗ 徽章追加 `title` 悬浮展示失败 detail（经 `esc` 转义）。
  - `testModelsAction`：结果行透传 `detail` 字段。
  - `updateApiFormUi`：非 fetchable 形态（anthropic-messages）时 hint 追加新 i18n 文案，明示"真实请求可用性测试目前仅支持 OpenAI 兼容形态"（配合既有按钮禁用逻辑，明示而非误报）。
  - i18n 三语新增 `testUnsupportedForm`（en/ja/zh）。
- `test/provider-web.test.js`：新增用例——mock 网关对 GET 一律 200（证明无 GET 短路）、`fake-body` 返回 200+error JSON（证明体校验）、`missing-model` 返回 404（证明状态码校验）、5 模型测峰值在飞 ≤3（证明并发上限）、断言仅发生 5 次 `POST /v1/chat/completions`。

### 预期结果
- 任意模型测试均发出真实 chat completion，"200 + error body" 型网关假阳性消除；
- 失败结果可通过 ✗ 徽章悬浮查看具体网关原因；
- 多模型测试并发收敛为 3，限流型网关下不再因 429 误判；
- Anthropic 形态下测试按钮维持禁用并明示不支持真实探测；
- 回归验证：`npm test` 全量 485 项通过（新增 1 项，耗时 ~20s）。
- 复现命令：`npm test`；本地起服务 `npm run web`。
