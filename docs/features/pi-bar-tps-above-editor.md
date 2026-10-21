# pi-bar t/s 嵌入输入框上边框左上角 技术变更说明

### 问题
t/s（tokens-per-second）药丸原先混在主状态栏左列车中（带药丸底色）。需求：移到
输入框左上角、不带背景、嵌入输入框本体显示。

### 原因
- 第一版方案（aboveEditor 独立行）被否：用户要的是"嵌入输入框"而非独立一行。
- pi-bar 已有同型机制：`DashedBorderEditor.render()` 将 UA 标签嵌入输入框下边框
  右端（`fitUserAgentBorder`，fitBorder 模式）。t/s 采用其左对齐镜像：嵌入上边框
  左端，标签走 `borderColor` 着色回调（含 ─→╌ 改写），与边框同色、无背景。
- 上边框行恒为 `lines[0]`（观测事实：pi-tui Editor 渲染顺序 顶规线在首行），
  以"stripSgr 后与规则行可见字形全等"为守卫，非规则行（自动补全展开等场景）不嵌。

### 修改点
- `plugin/pi-bar/index.ts`：
  - 新增模块级 `tpsBorderLabel`（emitTps 写入 `${Math.round(value)} t/s`）——
    模块级因 Editor 实例由宿主工厂在扩展闭包外构建；
  - 新增 `fitTpsBorder(label, width, border)`：`fitUserAgentBorder` 的左对齐镜像，
    `╌ 42 t/s ╌╌╌…` 形态，最小间隙 1 列，窄终端右缩标签，空值退化为全宽规则线；
  - `DashedBorderEditor.render()` 重构：守卫拆为 `width <= 2 || lines.length < 2`
    与 `if (!ua)` 两级（t/s 嵌入不依赖 UA 存在）；先嵌 t/s 于 `lines[0]`（当且仅当
    其为规则行），再反向扫描嵌 UA 于底规则行（`index <= 0` 守卫语义不变）；
  - 移除第一版的 `renderTpsLine` / `setWidget("pi-bar-tps")` / shutdown 清理；
  - `DEFAULTS.left` 无 tps、`loadSettings` 过滤用户 left 列表中的 tps、
    `SACRIFICE_IDS` 无 tps —— 三者保持（t/s 不再属于主栏列车）。
  - emitTps 仍发 `pi-bar:update`（驱动 dirty→refresh→宿主重渲染管道）。
- `test/pi-bar.test.js`：tps 用例改为嵌边断言（fitTpsBorder / tpsBorderLabel /
  lines[0] 嵌入 / pi-bar-tps 零残留）；UA 嵌边用例守卫断言同步两级拆分。
- 运行时生效：全局安装 `plugin/pi-bar/index.ts` 同步本补丁，`ensureBundledPi`
  指纹变化重建缓存并编译；编译产物已验证含 `fitTpsBorder`/`lines[0]` 嵌入且
  `pi-bar-tps`/`renderTpsLine` 零命中（验证事实）。重建方式：git push main →
  `axum update`，或下次 `axum code` 启动时指纹同步自动完成。

### 预期结果
- 输入框上边框左端内嵌 ` N t/s `（无底色，与虚线边框同色，随流式每 250ms 窗口刷新，
  空闲回落 0 t/s）；下边框右端 UA 标签行为不变。
- 验证：`node --test test/pi-bar.test.js` 26/26；`npm test` 498/498 全绿（事实观测）。
- 主状态栏左列为 git-branch → thinking → context-tokens（→ 弹性 context-usage），
  无 t/s 段；无独立 aboveEditor 行。
