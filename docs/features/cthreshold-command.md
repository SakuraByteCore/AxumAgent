# /cthreshold 自动压缩阈值命令 技术变更说明

### 问题
pi-companion 插件的自动压缩阈值原为硬编码常量 `COMPACT_THRESHOLD = 80`（80% 上下文占用即触发），
无任何查看或修改通道；冷却期已有 `PI_COMPANION_COMPACT_COOLDOWN_MS` 环境变量覆盖，阈值本身没有。

### 原因
按推荐方案定稿（规划阶段三项取舍均已按默认确认）：命令名取 `/cthreshold`（短且语义锁定）；
生效层级为"会话内即时生效 + 持久化"（对齐 `/ctx` 交互惯例）；取值边界严格 1–99，
始终保留自动压缩兜底（100 视为越界，杜绝依赖内核溢出兜底的歧义）。

### 修改点
- `plugin/pi-companion/index.ts`
  - `COMPACT_THRESHOLD` 常量拆分为 `COMPACT_THRESHOLD_DEFAULT/MIN/MAX`（80/1/99），
    运行时值收敛到可变 `compactThreshold`；`maybeCompact` 与 `tryDeferredCompact` 改读该变量。
  - 新增 `loadPersistedCompactThreshold` / `persistCompactThreshold`：读写
    `~/.pi/agent/extensions/pi-companion/config.json` 的 `compactThreshold` 键，
    写入走 tmp 文件 + `rename` 原子替换；与既有 `pi-response-guard` 配置路径互不冲突。
  - 插件初始化处 fire-and-forget 加载持久值，非整数或越界值回退默认 80。
  - 注册 `pi.registerCommand("cthreshold")`：无参显示当前值；带参校验
    （非数字/越界报 warning 并保持现值），合法值即时生效并持久化，
    持久化失败降级为"仅会话内生效"并提示。
- `test/pi-companion.test.js`
  - 既有阈值用例的 hermetic 输入由 85%/50% 改为 100%/0%，避免与持久化阈值相互影响。
  - 新增两用例：默认值展示 + 越界拒绝 + 合法值落盘断言；启动加载持久值断言
    （`withBareHome` 隔离 HOME，测试自恢复为 80）。

### 预期结果
- 回归验证：`node --test test/pi-companion.test.js` → 82 pass / 0 fail（含 2 条新用例）。
- 重建验证：`node -e "import('./src/ensure-bundled-pi.js').then(m=>m.ensureBundledPi({env:process.env}))"`
  按指纹增量同步并重编译；活跃缓存 `bundled-pi/v4/android-arm64/pi-b3034b7ad9a6/node_modules/pi-companion/index.js`
  已含 `cthreshold` 注册，`node --check` 语法通过。
- 生效链路：改动落在插件源码（非易失副本），新会话启动即加载；`/cthreshold` 显示当前值，
  `/cthreshold 60` 立即生效并跨会话持久；`/cthreshold 100` 报 warning 保持现值。
- 提交：`feat(pi-companion): add /cthreshold to view and set auto-compact threshold`。
