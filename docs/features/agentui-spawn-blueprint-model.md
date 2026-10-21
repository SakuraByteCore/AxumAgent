# /agentui 会话级 spawn/blueprint 模型选择面板 技术变更说明

### 问题
`/spawn` 与 `/blueprint` 预设此前只能继承当前会话模型（或每次手输 `-m`），缺少一个仅对当前会话生效的交互式模型选择入口。

### 原因
预设定格为：新增 `/agentui` 斜杠命令，启动一个会话级 mini web 服务（随机端口 + 随机 token，沿用 provider-web 已验证模式），页面提供 spawn/blueprint 两个模型下拉（默认 auto）；选择通过进程内存共享通道在派发时生效，会话进程退出即失效，天然限定"仅当前会话"。

### 修改点
- `plugin/pi-agent/agentui-prefs.ts`（新增）：共享通道纯函数模块。globalThis 键 `axumAgentUiModelPrefs`、形状守卫 `readAgentUiPrefs`/`isAgentUiModelRef`、`presetFromInvocation`（仅 `/spawn`、`/blueprint` 前缀命中）、`resolveAgentUiModelOverride`（校验 sessionId 一致才返回覆写；auto=null 永不覆写）。零运行时相对依赖，可直接被 node --test 导入。
- `plugin/pi-agent/runner.ts`：`resolveChildDispatchServices` 新增 `invocation` 参数，在 `forwarded.model ?? ctx.model` 之后读取 agentui 覆写；`modelRuntime.getModel` 解析成功则替换派发模型，失败时 `ctx.ui.notify` 警告并回退 auto（继承当前会话模型）。两处调用点（`startUserAgent`、`resumeOneFailedAgent`）已同步传入 invocation。派发回显复用既有 `formatStartNotification` 的 `modelLabel` 字段，无需额外改动。
- `plugin/pi-companion/agentui.ts`（新增）：`/agentui` 命令实现。单例 HTTP 服务（127.0.0.1:0 随机端口、randomBytes token、403 校验）；页面两个下拉 + Save；`/api/state` 回显已保存值；`/api/save` 校验选项必须存在于清单后写入 globalThis 通道（400 拒绝非法值）。模型清单与 `/usemodel` 同源（ensureZenProvider 同步 + `~/.pi/agent/models.json` + parseModelManifest/buildModelOptions）。`openUrlInBrowser` 为本地小助手（bundled-pi cache 内不可达 `../../src`，故不 import provider-web）；无浏览器时 notify 输出带 token 的 URL 兜底。重复调用复用已运行 server 并重新绑定当前 sessionId。
- `plugin/pi-companion/index.ts`：导入并调用 `registerAgentUi(pi)` 注册命令。
- `test/agentui.test.js`：12 例覆盖 preset 前缀判定（含大小写/多空格边界）、形状守卫（非对象 slot、非法/空 sessionId、单侧 malformed 降级）、会话隔离、auto 不覆写、清单校验、blueprint 覆写命中，以及 `chooseDispatchModel` 优先级链（显式 -m > 面板选择 > 继承当前模型；失效面板选择警告一次并回退；warn 可选不抛）。
- `test/agentui-panel.test.js`（新增）：4 例端到端覆盖命令注册、403（缺失/错误 token）、页面渲染（双下拉 + auto + current hint + XSS 模型 id 实体转义 + 无 CSS.escape）、save 往返写 slot 并经 /api/state 回显、400 非法/畸形选项且不污染 slot、500 坏 JSON/超长 body 后服务仍存活、404、单例复用同端口 + 跨会话重绑定后旧保存不可见、空清单时 warning 提示。使用 mkdtemp HOME + AXUM_AGENTUI_NO_OPEN=1 + PI_COMPANION_ZEN_SYNC_DISABLE=1 隔离环境。

二次排查（缺陷修复轮）：
- `plugin/pi-agent/agentui-prefs.ts`：新增泛型纯函数 `chooseDispatchModel<M>`——显式 `-m` > `/agentui` 面板选择 > 继承当前会话模型；面板选择失效（清单中已不存在）时 warn 一次并降级继承。泛型化保持模块零依赖，runner 侧自动推断为 Model。
- `plugin/pi-agent/runner.ts`：`resolveChildDispatchServices` 派发模型改为经 `chooseDispatchModel` 解析——修复语义缺陷：此前面板覆写会压过用户显式 `-m` 参数。
- `plugin/pi-companion/agentui.ts`：① `pageHtml(p)` 参数化为面板实例（消除对模块级单例的依赖，闭包内渲染 server 自身状态）；② 前端 `setSelectValue` 改为遍历 `select.options` 匹配（修复 `CSS.escape` 属性选择器对含 `/` 的模型 id 恒失配导致刷新后回显 auto）；③ 单例复用重绑会话时重置 `panel.prefs`（修复旧会话保存值经 /api/state 回退分支泄漏给新会话）；④ `openUrlInBrowser` 增加 `AXUM_AGENTUI_NO_OPEN=1` 逃逸口（对齐 provider-web 的 AXUM_PROVIDER_WEB_NO_OPEN，供测试/无头环境禁开浏览器）；⑤ 新增 `closeAgentUiPanel()` 供测试收口。`commandAvailable` 与 provider-web 权威实现逐字一致（含同款 DEP0190 行为），保持不漂移。
### 预期结果
- TUI 中 `/agentui` 打开面板，选择保存后，同会话内 `/spawn`、`/blueprint` 派发使用所选模型（启动通知 modelLabel 回显确认）；用户在同一次派发中显式传 `-m` 时以 `-m` 为准（面板不覆盖显式参数）；`/agent`、`/scout`、`/dispatch` 行为不变；选 auto 恢复继承；换会话后旧选择不可见。
- 验证依据：`npm test` 464 用例（455 过 / 9 败），失败集与基线 9 例（pi-header×3、plan×2、preset 前缀×3、preset empty args×1）完全一致、零新增失败，连续两轮结果稳定；新增 16 例全部通过（agentui.test.js 12 + agentui-panel.test.js 4）；bundled-pi cache 重编译产物（agentui.js/agentui-prefs.js/runner.js）经 node --check；headless 冒烟对编译产物实测：页面 options 匹配器在场且无 CSS.escape、fixture 模型入页、save 写 slot 成功、显式 -m 压面板、面板压继承、失效选择回退并警告全通过。
