# [全局 Prompt 历史] 变更说明

### 问题

- `npm run web` 的提示词历史面板只能按项目分组展示记录，没有任何跨项目共享的入口。
- 用户希望把某条提示词提升为全局提示词，在所有项目的编辑器历史中直接复用。
- 全局记录一旦可批量清理，误删会同时影响全部项目，因此全局记录必须只能逐条移除。

### 原因

- 提示词历史当前按项目落在 `<agentDir>/sessions/<slug>/prompt-history`，文件级作用域天然是单项目。
- `src/provider-web.js` 的历史面板渲染、批量删除、`delete-all` 三条路径共用同一份 `historyCache` 与 `selectedHistory`，若不隔离作用域，批量操作会误伤全局记录。
- `plugin/pi-bar` 的编辑器历史与 `/history` 选择器共用 `sharedPromptHistory`，全局记录需要进入前者供跨项目复用，但不能进入后者的删除范围。

### 修改点

- `src/prompt-history-store.js`
  - 新增 `GLOBAL_PROMPT_HISTORY_PROJECT = "__global__"` 与 `getGlobalPromptHistoryFile()`，全局文件为 `<agentDir>/prompt-history-global`。
  - `listPromptHistory()` 把全局记录作为 `scope: "global"` 的伪项目放在首位返回，项目条目补充 `scope: "project"`。
  - 新增 `promotePromptHistoryEntry()`：把项目文件中的一条记录移动到全局文件（已存在于全局则不重复写入），并清理空项目目录。
  - 新增 `deleteGlobalPromptHistoryEntry()`：只按单个 `index` 删除全局记录，是全局记录唯一的删除入口。
  - `deleteAllPromptHistory()` 仍只遍历 `sessions/` 下的项目目录，全局文件不受影响。
  - 导出/导入携带全局条目：导出项标记 `project: "__global__"`、`scope: "global"`；导入按 `scope` 判定落到全局文件或项目文件。
- `src/provider-web.js`
  - 新增 `POST /api/prompt-history/global/promote`（入参 `project` + `index`）与 `POST /api/prompt-history/global/delete`（入参 `index`）。
  - 历史面板新增“全局提示词”分区：全局条目只有删除按钮，没有勾选框，不参与 `selectedHistory`。
  - 项目条目新增“设为全局”按钮，调用 promote 接口把该条记录移入全局历史。
  - 批量删除与“删除项目历史”只作用于项目条目；确认文案明确提示全局提示词会被保留，无项目条目时隐藏该按钮。
  - 全局文案使用独立的 `HISTORY_I18N`（en/ja/zh），不改动巨型 I18N 主表。
- `plugin/pi-bar/prompt-history.ts`
  - 新增 `globalPromptHistoryPath(agentDir)`，指向同一个 `<agentDir>/prompt-history-global`。
- `plugin/pi-bar/index.ts`
  - 拆分 `projectPromptHistory` 与 `globalPromptHistory`，`rebuildSharedPromptHistory()` 合并两者供编辑器 ↑/↓ 复用。
  - `ensurePromptHistoryLoaded()` 同时加载项目与全局文件；`persistPromptEntry()` 只写项目文件并刷新共享列表。
  - `/history` 选择器只列出并删除项目条目，全局记录只能通过 Web 逐条移除。

### 预期结果

- `npm run web` 打开历史面板后，项目条目旁出现“设为全局”，点击确认后该条记录从项目历史移入顶部“全局提示词”分区。
- 全局分区条目没有勾选框，批量删除与“删除项目历史”不会命中全局记录。
- 全局记录只能通过条目上的删除按钮逐条移除。
- 全局记录在任意项目的 pi-bar 编辑器历史中都可直接复用，`/history` 选择器仍只管理项目条目。
- 导出/导入可完整携带全局记录。

### 验证

- `node --test test/prompt-history-store.test.js test/prompt-history-dom.test.js test/pi-bar-prompt-history.test.js` → 33 通过 / 0 失败。
- `node --test --test-name-pattern='promotes one prompt to global' test/provider-web.test.js` → 1 通过 / 0 失败。
- `npm run build` → 通过。
- `node --check src/provider-web.js`、`node --check src/prompt-history-store.js`、`git diff --check` → 通过。

### 证据

- 观测事实：项目历史文件位于 `<agentDir>/sessions/<slug>/prompt-history`；Web 端 `GET /api/prompt-history` 返回项目分组；批量删除与 `delete-all` 均以项目目录为遍历对象。
- 确定推导：全局记录独立成文件后，批量删除遍历不到该文件，`delete-all` 与 `delete-batch` 自然无法命中全局记录；单条删除接口是全局记录唯一可达路径。
- 分析推论：pi-bar 侧把全局记录并入共享列表可实现跨项目复用，同时把选择器数据源限定为项目数组可满足“只能单独移除”的约束。
- 未知盲区：`test/provider-web.test.js` 其余用例在本环境因鉴权头缺失返回 403，属于改动前既有失败，本次新增用例已改用页面内 token 头验证。
