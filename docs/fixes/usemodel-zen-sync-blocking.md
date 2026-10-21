# /usemodel 选择器慢打开（Zen 同步阻塞）修复说明

### 问题
打开 `/usemodel` 后选择器经常要等十几秒才出现，网络差时每次打开都慢。

### 原因
- **观测事实**：`plugin/pi-companion/index.ts:1330` 的 handler 在 `ctx.ui.select` 之前 `await ensureZenProvider(agentDir)`，选择器必须等 Zen 目录同步完成才出现。
- **观测事实**：缓存过期时同步串行拉两个接口：S1 `opencode.ai/zen/v1/models`（实测 1.7~3.3s）+ S2 `models.dev/api.json`（当前网络实测挂起至 8s 超时不可达），单次最坏阻塞 ≈ 11~16s（`LIVE_FETCH_TIMEOUT_MS = 8000`）。
- **确定推导**：S1 失败回退旧缓存（`source: "cache"`）时旧实现不回写缓存时间戳 → 缓存永远过期 → 网络差时每次打开重复烧满超时；缓存 TTL 24h，网络正常时每天也有一次 ~5-11s 卡顿。
- 已排除环节：models.json 本地解析、选择器 initialSelectedIndex 补丁、选中后的 `modelRegistry.refresh`（`allowNetwork: false`）均为毫秒级本地操作。

### 修改点
- `plugin/pi-companion/opencode-zen.ts`：
  - 新增 `LIVE_FETCH_FAILURE_COOLDOWN_MS = 1h` 常量；缓存条目新增 `lastFailedAttemptAt` 字段，`writeCatalogCache` 支持写入该字段。
  - 原 `ensureZenProvider` 拆分为两个导出入口：
    - `ensureZenProviderLocal`：零网络快速路径，用磁盘缓存（任意年龄，过期缓存仍优先于静态兜底，维持原降级顺序）或编译期静态列表做本地合并，返回 `needsLiveRefresh`（缓存缺失/过期 且 未处失败冷却 且 未设置禁用/离线环境变量）。
    - `refreshZenProviderLive`：仅做 live 拉取与合并；成功则回写缓存时间戳并清除失败标记；失败则在缓存上打 `lastFailedAttemptAt`（保留原 writtenAt，绝不伪造新鲜），进入 1 小时冷却。
  - `ensureZenProvider` 保留为两者组合（旧调用方/测试语义兼容）。
- `plugin/pi-companion/index.ts`：`/usemodel` 改为先 `ensureZenProviderLocal`（毫秒级本地合并后立即出选择器），`needsLiveRefresh` 时经 `startZenBackgroundRefresh` 后台静默刷新（带 in-flight 去重），完成后 toast "synced N free Zen models in the background; they list on the next /usemodel"，失败 toast 警告并提示 1h 冷却。
- `plugin/pi-companion/agentui.ts`：`loadModelEntries` 同根因同修，面板不再等待网络（本地合并 + 静默后台刷新）。
- `test/pi-companion.test.js`：新增 3 项测试——本地零网络路径与刷新时机标记、失败冷却打点与成功清除、`/usemodel` 不等网络即出选择器（mock 全局 fetch 为永不自动 resolve 的挂起 Promise，证明同步已完全后台化）。

### 预期结果
- `/usemodel` 选择器毫秒级出现（本地缓存/静态列表渲染），不再有任何网络等待。
- 网络正常时：后台刷新完成后 toast 提示，下次打开即为最新免费模型列表。
- 网络失败时：失败尝试被记录，1 小时内不再重复拉取（选择器始终零等待），冷却到期自动重试；成功后恢复正常 24h TTL。
- 全量回归：`npm test` → 485 pass / 0 fail（含原有 ensureZenProvider 语义测试不变）。
