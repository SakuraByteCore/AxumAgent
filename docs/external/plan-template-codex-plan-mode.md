# /plan 模板 codex 化（生效文件 + 双插件内置回退同源）技术变更说明

> 目标绝对路径：`/data/data/com.termux/files/home/.pi/agent/plan-prompt.md`（生效模板）与 `pwd/plugin/pi-companion/index.ts`、`pwd/plugin/pi-agent/plan-prompt.ts`（双内置回退，pwd 内）
> 目标环境：本地（Termux）
> 目标是否 Git 仓库：~/.pi 非 Git；pwd 为 Git 仓库
> 目标可写性：可写
> 是否易失副本：plan-prompt.md 为用户级配置文件，删除即回退内置模板；重建方式：git revert 两个插件提交后从常量复制，或按本归档附录

### 问题
原 /plan 模板为纯中文两阶段卡点文本，缺少 codex Plan Mode 的核心规则（模式锁、非破坏探查白名单、两类未知分流、`<proposed_plan>` 终稿契约）；且 pi-companion 内置回退模板（PLAN_PROMPT_PREFIX/MIDDLE/SUFFIX 三常量）为极简英文骨架，与生效文件完全脱节。

### 原因
用户确认组合 1A+2B+3折中+B：以 codex 官方 `codex-rs/collaboration-mode-templates/templates/plan.md` 为规则蓝本重写生效模板；保留两阶段卡点骨架与计数上限（方案≤5、步骤≤7、UAT≤5、待确认≤3），废除阶段2总字数≤600 硬顶（改 decision complete 标准）；内置回退与生效文件字节级同源。交付后用户要求彻底排查禁止返工，暴露出第二套镜像模块与测试断言断链，一并收口。

### 修改点
1. `~/.pi/agent/plan-prompt.md`：整文件重写。新增【模式铁律】【终稿契约】两节，移植 codex plan.md 规则：
   - 模式锁：规划态不因用户语气/催促/祈使句解除，仅“开始写”/“生成”终结（codex "Plan Mode is not changed by user intent, tone, or imperative language"）；
   - 非破坏探查白名单/禁改动项清单（codex "Allowed (non-mutating) / Not allowed (mutating)"）；
   - 两类未知分流：可发现事实先探查、偏好取舍给 2~4 互斥选项+推荐默认、未答按默认记假设（codex "Two kinds of unknowns"）；
   - 每问必须实质改变方案/锁假设/做取舍（codex "Asking questions" 三条件）；
   - `<proposed_plan>` 终稿契约：标签独占行、英文标签不译、每轮至多一块、块内纯方案不问“是否继续”（codex "Finalization rule"）。
   - 阶段1 增加证据锚点要求与“先探查再提问”（codex PHASE 1 explore-first）；阶段2 增加决策完备五要素（方法/接口/数据流/边界失败模式/测试验收兼容迁移，codex PHASE 3）。
   - 节标题纯净化：应用户要求，模板正文与双插件常量/注释不携带“移植自 codex”来源标注（【模式铁律】【终稿契约】不带括号后缀），规则内容不变。
2. `plugin/pi-companion/index.ts`（L13~L57 常量区）：PLAN_PROMPT_PREFIX/MIDDLE/SUFFIX 三常量由英文骨架替换为新模板同源内容，运行期拼接 PREFIX + requirement + MIDDLE + SUFFIX 与生效文件逐字节一致。
3. `plugin/pi-agent/plan-prompt.ts`（排查阶段发现的镜像断链收口）：该模块为 `/agent -P` 的第二套 buildPlanPrompt，源码注释明确要求与 pi-companion /plan 回退逐字镜像；三常量经脚本从 pi-companion 源直接提取拼接同步（零手抄转录），镜像注释更新为指向 codex plan.md。
4. `test/pi-companion.test.js`、`test/pi-agent.test.js`：四处内置回退断言由旧英文骨架（`[Requirement]`/`[Objective]`/`[Rules]`/"do not modify files"）更新为新模板内容（总则拼接、首席规划官、模式铁律、终稿契约、`<proposed_plan>`）；模板文件路径/占位符/空文件校验断言未动。

### 预期结果
- 生效链路：`/plan` 经 pi-companion buildPlanPrompt 优先读取 `~/.pi/agent/plan-prompt.md` 并替换 `{{requirement}}`；`/agent -P` 经 pi-agent buildPlanPrompt 读同一文件；文件缺失时两条回退路径输出同一模板（双镜像同源）。
- 验证依据：
  1. 占位符断言：`grep -c "{{requirement}}" plan-prompt.md` = 1（web 编辑器保存门禁通过条件）；
  2. 同源断言：stripTypeScriptTypes 解析后提取三常量拼接，pi-companion 与 pi-agent 双模块输出 byte-equal，且均与 plan-prompt.md（requirement 内联后）byte-equal（三向断言通过）；
  3. 编译冒烟：`ensureBundledPi({})` 以默认 platform 触发指纹同步与重编译，真实缓存根 `…/v4/android-arm64/pi-b3034b7ad9a6/plugin/` 下 pi-companion/index.{ts,js} 与 pi-agent/plan-prompt.{ts,js} 均含新模板（grep 命中 1）；
  4. 过程缺陷修正：冒烟首轮误传 platform 参数产生野缓存目录 `v4/android-arm64-arm64`（680MB），已整目录删除，磁盘无残留；
  5. 断链修复回归：基线 2 红（pi-companion 内置回退断言 `[Requirement] add login` 等）→ 修复后 `npm test` 全量 exit=0，点名用例（plan-first、CJK、fallback skeleton）全绿；
  6. 全仓旧骨架清扫：grep 命中仅剩 /rules 命令独立特性（index.ts L1172 `[Requirement]` 头）与 e2e 自包含 mock，与 plan 模板无耦合，无断链。
  7. 标注清理断言：生效文件与双插件常量/源码注释中“移植自 codex”标注清零（grep codex 仅剩 index.ts L1032 伪装请求头常量等无关项）；缓存产物 pi-companion/index.js 与 pi-agent/plan-prompt.js 移植自=0、模式铁律在场；npm test 全量 exit=0。
- 基线备份：`pwd/docs/external/plan-prompt.md.baseline`（sha256 与写前原文件一致 b099a914…be87）；回滚 = 备份回写 + `git revert` 两次插件提交。
- UAT（用户侧）：
  1. pi 会话执行 `/plan <需求>` → 输出前应可见只读探查，随后仅输出【待确认调研清单】（≤3项、每项 2~4 选项+推荐默认+证据锚点）；
  2. 规划中回复“直接改吧” → 仍输出规划内容（模式锁生效）；
  3. 确认后 → 阶段2输出含 `<proposed_plan>` 块、七节结构完整；
  4. web 编辑器（/setup 页 plan-prompt.md）→ 加载/保存/diff 正常；
  5. 临时移走 plan-prompt.md 后 `/plan` → 回退输出与新模板同源，随后恢复文件；
  6. 临时移走 plan-prompt.md 后 `/agent -P <需求>` → 回退输出与 `/plan` 回退逐字一致（双镜像同源验证）。
