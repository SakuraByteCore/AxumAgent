# /usemodel Zen 同步保留 /ctx 自定义 contextWindow 修复 技术变更说明

### 问题
用户要求：`/usemodel` 切换提供商绝对不能影响 ctx（contextWindow）变化。实测缺陷：每次打开 `/usemodel`（本地 Zen 同步路径）或后台 live 刷新，都会整体重建 `models.json` 中 `opencode` provider 块，用户经 `/ctx` 持久化到该块各模型条目的 `contextWindow` 被静默抹掉，回退为目录（catalog）值。

### 原因
- 事实观测：`plugin/pi-companion/opencode-zen.ts` 的 `mergeZenProvider` 直接以 `buildZenProviderBlock(catalog.models, headers)` 整块替换 `providers.opencode`，目录条目的 `contextWindow` 仅来自 models.dev 元数据（`buildZenModelInfo`），静态目录条目则完全没有该字段。
- 事实观测：`/ctx`（pi-companion）把 `contextWindow` 原子写入 models.json 对应模型条目，语义为"用户拥有的会话/磁盘配置"。
- 推论：两条写路径共享同一个 `opencode` 块且同步侧不感知用户覆盖值，重建即丢失；根因是合并策略缺一条"磁盘用户值优先"规则，而非 `/ctx` 或目录数据本身有误。

### 修改点
1. `plugin/pi-companion/opencode-zen.ts`
   - 新增私有 `collectContextWindows(block)`：从现存 opencode 块按模型 id 收集磁盘 `contextWindow` 覆盖值。
   - `mergeZenProvider` 在重建块前对目录模型做一次 map：磁盘有覆盖值且与目录值不同时，以磁盘值优先（`{ ...m, contextWindow: pinned }`）；无覆盖值的模型照常采用目录值。幂等比较逻辑不变（合并后与磁盘一致则不写文件）。
2. `test/pi-companion.test.js`
   - 新增用例 "mergeZenProvider preserves user-set contextWindow overrides"：断言 /ctx 调过的 999000 在目录重建后保留；磁盘覆盖值（128000）优先于目录新值（400000）；无覆盖值模型采用目录值（256000）。

### 预期结果
- 任何 `/usemodel` 打开（本地同步/后台刷新）都不会再改动用户经 `/ctx` 设置的 contextWindow；未动过的模型窗口仍随目录更新。
- 已知权衡：一旦某模型条目存在磁盘 `contextWindow`，上游目录后续对该模型窗口的修正不再自动生效；需手工删除该条目的 `contextWindow` 字段后重新同步即可恢复跟随目录。
- 验证：`node --test test/pi-companion.test.js` 83/83 通过；`npm test` 全量 502/502 通过（事实观测）。
- 构建命令：无独立构建；`npm run build` 的 node --check 检查集不含本 TS 文件，语法由测试直载 TS 验证覆盖。
