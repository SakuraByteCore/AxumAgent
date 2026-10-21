# 网关断流错误（"Upstream response stream was interrupted"）三层重试修复技术变更说明

### 问题

ss2api 网关上游断流时返回 `Upstream response stream was interrupted`，回合直接以
`stopReason:"error"` 死亡，无任何重试（失败会话 L198 实证：assistant 消息带该
errorMessage，回合终止）。用户观察：请求错误直接停止。

### 原因

该文案被三层防线同时放行（全部实测 miss）：

1. **传输层连接通道**是双门禁（bundled-pi-patches.js 注入
   `isConnectionError(msg) && this._isRetryableError(message)`）：
   - 连接词表 `PI_CONNECTION_ERROR_PATTERN_SOURCE` 无 interrupt 系词，不命中；
   - retry.js `RETRYABLE_PROVIDER_ERROR_PATTERN`（"terminated"/"ended without" 等）
   同样不含 interrupted，不命中；双门全 miss → 不进入 3s×30 固定节奏重试通道。
2. **守卫层**（pi-companion 自动 continue）errorPatterns 为子串匹配，默认表仅有
   "stream interrupted"，不匹配 "stream **was** interrupted" → 也不触发兜底续跑。

网关变体文案（"connection interrupted"、"request interrupted" 等）同理全部漏网。

### 修改点

- `src/bundled-pi-patches.js`
  - 连接词表追加泛化词 `interrupt(ed)?`（与 terminated/timeout 等既有宽松词风格
    一致；用户主动中断走 `stopReason:"aborted"` 独立路径，不受影响）。
  - 新增 `PI_CONNECTION_ERROR_PATTERN_UPGRADE_SOURCES` 显式升级世代列表
    （deadline 世代 → legacy → v1，最新优先整体替换，杜绝词项原地重复）；
    `upgradePiAgentSessionConnectionPattern` 改为迭代该列表。
  - 新增 `patchPiAiInterruptedRetryable`（marker `AXUM_PI_INTERRUPTED_RETRYABLE`）：
    在 retry.js `return RETRYABLE_PROVIDER_ERROR_PATTERN.test(...)` 前注入
    `if (/interrupt(ed)?/i.test(errorMessage)) return true;` 前置判定，保持双门禁
    语义（billing/quota 等不可重试文案不会误入连接通道）；接入
    `patchPiAiRetryable422` 的全新缓存与旧缓存升级两条路径（retAnchor 在所有
    世代均保留，旧缓存无需额外升级机制）。
  - 新增 `upgradePiConnectionDisplayPattern`：缓存显示层 helper 以 JSON 字符串
    字面量嵌入词表，按同一升级世代列表原地换新；两个显示补丁
    （assistant-message / interactive-mode）的 marker 早退分支改为走升级。
  - 导出 `patchPiAiInterruptedRetryable`。
- `plugin/pi-companion/index.ts`：`DEFAULT_CONFIG.errorPatterns` 与
  `ensureBundledConfigFile` 内联默认表各追加 `"interrupted"` 子串（覆盖
  "stream was interrupted" 及全部变体）。
- `plugin/pi-companion/config.json`：物理捆绑默认表同步追加 `"interrupted"`。
- 测试：
  - `test/bundled-pi-patches.test.js`：词表分类测试加网关断流正例；新增 retry.js
    interrupt 通道注入/旧缓存（422+deadline 世代）原位升级/幂等/缺锚点抛错测试；
    新增显示缓存三种世代（deadline 字面量/纯 legacy/无锚点）升级测试。
  - `test/resolve-bundled-pi.test.js`：分类测试加正例；连接通道缓存升级测试
    扩展 deadline 世代实弹输入，并断言 `interrupt(ed)?` 注入。
  - `test/stress-retry.test.js`：守卫瞬态表加
    "Upstream response stream was interrupted"（走 DEFAULT_CONFIG 表断言自动
    continue 恢复计数）。

### 预期结果

- 断流错误进入连接通道：3s 固定节奏、独立计数、最多 30 次（约 90s）透明重试，
  不耗用户重试预算；重试期间错误气泡显示软化中文提示不刷红。
- 双门禁语义不变：429 通道与用户重试预算不受影响；守卫层对未收录变体兜底
  （回合死后自动 continue 续跑）。
- 旧缓存无需重建：下次 pi 启动时 `patchFileInPlace` 自动原地升级（marker 守卫 +
  世代列表替换）。
- 验证：
  - 单套件 `node --test test/bundled-pi-patches.test.js test/resolve-bundled-pi.test.js test/stress-retry.test.js` 86/86；
  - 全量 `npm test` 469/469（历史基线 466 + pi-agent 任务 1 + 本任务新增 2，零新失败）；
  - 真实缓存演练：对本机 `~/.cache/axum-agent/bundled-pi/v4/android-arm64/pi-da11b57995b3`
    下 4 个缓存文件（retry.js / agent-session.js / assistant-message.js /
    interactive-mode.js）实文跑补丁函数，全部注入 interrupt 通道且幂等。
- 用户 UAT：重启 pi 后触发一次网关断流，观察自动重试提示与回合自动恢复；
  `grep "AXUM_PI_INTERRUPTED_RETRYABLE" <缓存>/…/retry.js` 应命中（启动后已升级）。
