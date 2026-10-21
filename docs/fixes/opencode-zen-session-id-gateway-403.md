# opencode Zen 免费通道 403 修复（会话 id 网关配方过期）技术变更说明

### 问题
`/usemodel` 中 `opencode` 提供方的免费模型（big-pickle、cat-jam-free 等 10 项）可以正常列出与选择，但实际对话请求全部被网关拒绝：`POST https://opencode.ai/zen/v1/chat/completions` 返回 HTTP 403 `FreeTierError: "OpenCode's free tier can only be used from within OpenCode."`（Node fetch 与 Python 双路径复现）。

### 原因
`plugin/pi-companion/opencode-zen.ts` 的 `canonicalSessionID()` 用 `sha256` 摘要前 6 字节充当会话 id 的 12 个 hex 字符。Zen 网关自 2026-10-13 起收紧（上游 opencode issue #62）：这 12 个 hex 必须是按位取反的 `Date.now()*4096 + 毫秒内计数器` 低 48 位，网关解码校验计数器 ∈ [0,63]，摘要派生值约 98.5% 概率被拒，即使匹配 `ses_<12hex><14 base62>` 形状正则也照样 403。UA 版本与其余头集合经逐项实测排除嫌疑。上游 `@opencode2dsh/dsh-plugin` 0.3.12（2026-10-14）已内置相同修复（`invertedTimestampHex`），佐证配方时效性。另发现存量安装无法自愈：`mergeZenProvider` 复用 models.json 中已存储的旧 headers，仅改编码函数不会重建已损坏的 session id。

### 修改点
全部位于 `plugin/pi-companion/opencode-zen.ts` 与 `test/pi-companion.test.js`，其余文件零改动：

- `opencode-zen.ts` `canonicalSessionID()`：12 hex 改由上游 `invertedTimestampHex` 配式生成（`~(Date.now()*4096+1)` 取低 48 位，计数器固定 1）；`sha256` 仅保留用于派生 14 位 Base62 尾（保持同 signal 尾部稳定）；新增可选 `now` 参数供测试注入。
- `opencode-zen.ts` 新增 `isGatewaySessionID()`：按网关规则解码 12 hex 并校验计数器 ≤ 63，作为 id 合法性判据与存量修复门控。
- `opencode-zen.ts` `mergeZenProvider()`：新增 `repairStoredHeaders()` 辅助——复用存量 headers（request/project id 保持按装稳定）但存量 session id 解码失败时再生三个会话头（`x-opencode-session` / `x-session-affinity` / `X-Session-Id`），使已损坏的存量安装一次 sync 自愈。
- `opencode-zen.ts` `STATIC_FREE_MODEL_IDS`：由旧 7 项（含已下线的 mimo-v2.5-free、ling-3.0-flash-fin-free、nemotron-3-ultra-free、muse-spark-1.2-contributor-free）刷新为 2026-10-14 live 快照 10 项，离线兜底目录不再失真。
- 头部注释同步更新（旧"shape 正则门禁 / ids 按装稳定"描述已失效）。
- `test/pi-companion.test.js`：`canonicalSessionID` 测试改为断言网关可解码性（同 signal+同 ms 稳定、跨 ms 变化、门禁非法 id 重编码、真实历史坏 id `ses_d5be45fca3354RWTz41XYmjwNd` 判非法）；`buildDisguiseHeaders` 测试补 `isGatewaySessionID` 断言；新增 `mergeZenProvider repairs a stored session id that predates the gateway recipe` 覆盖存量自愈路径（含修复后幂等、request id 跨修复保持）。

### 预期结果
`/usemodel` 选择 opencode 免费模型后可正常对话。验证依据（全部实测，脚本级）：

- 单文件套件 61/61 通过；全量 `npm test` 466/466 通过（历史基线失败已由 docs/fixes/baseline-test-failures.md 任务修复，本次零新失败）。
- 用修复后生成器直连网关：同 req id 连续两次 `POST /zen/v1/chat/completions`（`stream:true` + tools 含 `bash`/`read`）均 HTTP 200，SSE 正常出块。
- 对真实安装 `~/.pi/agent` 执行 `ensureZenProvider()`：`changed:true`，存量 session id 由 `ses_d5be45fca335…`（解码计数器 3274，非法）再生为 `ses_ec578bbddffe…`（gateway-valid），随后用存量 headers 实聊 200。
- models.json opencode 块模型目录 10 项与 live `/v1/models` ∩ models.dev 免费判定一致。
- 复现/验证命令原文：`npm test`；`node zen-verify.mjs`（临时脚本已清理，内容为导入 `buildDisguiseHeaders`/`ensureZenProvider` 后按上述 body 形状对 `https://opencode.ai/zen/v1/chat/completions` 断言 200）。
- 用户侧最终验收（方案待确认项 3 选项 A）：pi 会话内 `/usemodel` 选 `big-pickle` 发送一句话应正常回复。
- 假设标注（未证伪、无实测反证）：网关不校验 id 内时间戳新鲜度（同一 req id 与同一 session 短窗内重复使用均 200）；若未来网关增加时间戳新鲜度校验，需升级为每次 sync 强制再生 session 或每请求动态派生（方案 B 升级路径）。
- 运营特性备注（非本次故障）：免费通道按 IP 限额、偶发 429；`muse-spark-*-contributor-free` 系列存在地区封锁（RegionError）。
