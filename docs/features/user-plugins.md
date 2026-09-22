# User Plugin System 技术变更说明

### 问题

用户需要为 Axum 添加自定义本地插件（如 Electron CDP 日志收集器），但现有架构要求在 `src/bundled-pi-packages.js` 中注册插件，导致每次添加插件都需要修改核心代码，无法实现开箱即用的扩展性。

### 原因

**现有插件加载机制的局限性：**
- 所有插件必须在 `bundled-pi-packages.js` 中硬编码注册
- 插件路径解析依赖 `node_modules` 结构
- 无用户级或项目级插件目录支持
- 缺少插件创建与管理工具链

**设计驱动：**
实现三层插件优先级体系（Project → User → Bundled），支持开发者在不修改核心代码的情况下添加自定义插件，同时保持与现有 Pi Extension API 的完全兼容。

### 修改点

#### 1. 插件发现机制 (`src/bundled-pi-platform.js`)

新增三个核心函数，实现用户插件扫描与统一加载：

- **`getUserPluginPaths()`**: 扫描 `~/.axum/plugins/` 目录，返回用户全局插件列表。每个插件目录必须包含 `index.ts` 或 `index.js` 入口文件。
- **`getProjectPluginPaths()`**: 扫描 `./axum-plugins/` 目录，返回项目本地插件列表。
- **`getAllPluginExtensions()`**: 统一插件发现接口，按优先级合并三层插件（Project → User → Bundled）。

**关键实现细节：**
- 插件元数据包含 `userPlugin: true` 标记，用于区分用户插件与打包插件
- 用户插件的 `extensionPath` 为绝对路径，跳过 `node_modules` 解析
- 目录不存在或读取失败时降级为空数组，不阻塞启动

#### 2. 扩展加载集成 (`src/resolve-bundled-pi.js`)

修改 `resolveBundledExtensions()` 函数：
- 调用 `getAllPluginExtensions()` 替代原有的 `supportedBundledPiExtensions()`
- 对 `userPlugin: true` 的插件直接返回绝对路径
- 对打包插件保持原有的 `packageRoot` + 相对路径解析逻辑
- 保持编译产物优先（`.js` over `.ts`）的兼容逻辑

#### 3. 用户插件管理器 (`src/user-plugin-manager.js`)

提供完整的插件创建与管理工具链：

**核心函数：**
- `createPluginTemplate(name, options)`: 生成插件模板，包含 `package.json`、`index.ts` 和 `README.md`
- `listAllPlugins(options)`: 列出所有已加载插件（用户 + 项目 + 打包）
- `formatPluginList(plugins)`: 格式化插件列表，按来源分组显示

**模板内容：**
- `package.json`: 符合 npm 规范的最小配置
- `index.ts`: Pi Extension API 标准实现，包含工具和命令示例
- `README.md`: 安装说明、使用示例与 API 参考

#### 4. 命令行接口 (`plugin/pi-companion/index.ts`)

在 pi-companion 扩展中新增 `/plugin` 命令：

**子命令：**
- `/plugin list`: 列出所有已加载插件，按来源（Project / User / Bundled）分组
- `/plugin create <name>`: 在 `~/.axum/plugins/<name>/` 创建用户全局插件
- `/plugin create-project <name>`: 在 `./axum-plugins/<name>/` 创建项目本地插件

**实现特性：**
- 动态导入 `user-plugin-manager.js`，避免打包依赖
- 创建后提供明确的后续步骤指引
- 错误处理与用户友好的提示信息

### 预期结果

**功能验证：**
1. 运行 `axum code` 后，Pi 自动加载 `~/.axum/plugins/` 和 `./axum-plugins/` 中的所有有效插件
2. `/plugin list` 正确显示三层插件来源
3. `/plugin create electron-cdp` 生成完整的插件模板
4. 重启 Axum 后，新创建的插件被成功加载并可通过工具和命令调用

**实际验证结果（端到端自测通过）：**
- ✅ `axum update` 安装验证通过（9 个打包插件，不验证可选用户插件）
- ✅ `axum code` 正常启动，无扩展加载错误
- ✅ `/plugin list` 正确列出用户插件
- ✅ `/plugin create <name>` 生成模板并可加载
- ✅ 用户插件出现在扩展列表首位（最高优先级）

**端到端自测发现并修复的运行时缺陷（全部并入本任务）：**
- pi-bar 直接 `import "../../src/provider-config.js"`（axum 内部模块），同步进 Pi cache 后路径断裂导致整个会话启动失败；改为运行时读 `process.env.AXUM_USER_AGENT`（axum 启动时已注入），解除打包插件对 axum 内部模块的耦合
- pi-companion 的 `/plugin` 通过动态 `import("../../src/user-plugin-manager.js")` 加载管理逻辑，但扩展编译后位于 Pi cache 的 `node_modules/pi-companion/`，该相对路径不可解析；改为在 pi-companion 内联实现插件扫描与模板生成
- `user-plugin-manager.js` 在 ESM 模块内使用 `require()`，`/plugin list` 抛 `require is not defined`；改为顶层 `import`
- `/plugin` handler 调用不存在的 `ctx.ui.writeLine`；改用 `ctx.ui.notify(msg, "info")` 并将多行输出合并为单次通知
- 生成的插件模板采用 `export const extension = { activate(ctx) {...} }` 对象格式，Pi 要求工厂函数 `export default function (pi) {...}`；已改为工厂函数并在其中调用 `pi.registerTool(...)`（Pi 的工具注册 API 为 `registerTool`，非 `tool`）；模板内层反引号与 `${}` 插值做了转义，确保生成代码中 `input.message` 保持字面量、`name` 在创建时被替换
**插件优先级验证：**
- 同名插件按 Project → User → Bundled 顺序加载
- 用户插件可覆盖打包插件的默认行为

**下一步扩展：**
参考本架构实现 Electron CDP 插件，使用 `chrome-remote-interface` 连接 `--inspect=9229` 和 `--remote-debugging-port=9222`，实现主进程与渲染进程日志的自动收集。
