> 子任务默认使用内置 `controlled-pi`，沿用主 Agent 已配置的模型、Provider 与认证，无需 Docker、外部 CLI 或额外 API Key。每次派发都是独立的一次性任务；`manage_agent` 仅支持 `status` / `wait` / `interrupt` / `close` / `history`，不支持 `send` / `resume` / `rebase`。

# Axum Agent

<p align="center">
  <a href="./LICENSE"> <img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat-square" alt="License"> </a>
  <a href="https://nodejs.org"> <img src="https://img.shields.io/badge/node-%3E%3D22.19.0-green?style=flat-square" alt="Node"> </a>
  <a href="#环境要求"> <img src="https://img.shields.io/badge/runs%20on-Android%20%2F%20Termux-3ddc84?style=flat-square" alt="Runs on Android/Termux"> </a>
</p>

<div align="center">
  <h1>Axum Agent</h1>
  <p>一条命令装好的完整编码代理：Pi 本体 + 12 个精选扩展，打包同启。macOS、Linux、Windows 之外，Android/Termux 同样一等支持。</p>
</div>

> 一条 `npm install -g`（main 分支 tarball）全部就位：无需 clone、无需构建、无需逐个挑选扩展。

- **一条命令，全家桶就位** —— Pi 本体与 12 个打包扩展（快捷指令、后台 Agent、持久记忆、todo、Web 工具）同装同启；自包含运行时存于用户缓存，重装不重复首次安装流程。
- **手机上也能跑** —— 一等支持 Android/Termux：同一条命令把 Termux 变成编码代理。
- **一键后台 Agent** —— `/spawn`（独立任务）、`/scout`（独立调研）、`/blueprint`（规划模式）一键发射后台 Agent，实时进度挂件 + 结果自动回传。
- **跨会话持久记忆** —— `pi-memory` 以单个 JSON 文件持久化记忆，零原生依赖（/memory save|find|recall|clear）。
- **MCP 开箱即用** —— `axum mcp add` 添加即生效；配置格式与 Cursor、Claude Code、Codex 通用。
- **Web 配置 + 安全模式** —— Provider、重试与系统提示词设置均在本地 Web UI 完成；任何损坏的扩展都可被跳过，仅启动 Pi 本体。

- **命令 Hook** —— 在 `~/.pi/agent/hooks.json`、`.pi/hooks.json` 或 `.pi/hooks.local.json` 配置 `hooks`。支持会话、输入、工具、停止及压缩事件的同步命令；项目配置要求项目信任。设置 `disableAllHooks: true` 可关闭。

## 目录

- [打包运行时](#打包运行时)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [MCP 服务](#mcp-服务)
- [配置 Provider](#配置-provider)
- [重试设置](#重试设置)
- [编辑 System Prompt](#编辑-system-prompt)
- [Doctor](#doctor)
- [更新](#更新)
- [License](#license)
- [翻译](#翻译)

## 打包运行时

本分发包含以下包，一次安装全部就位:

- `@earendil-works/pi-coding-agent`
- `pi-bar`（AxumAgent 打包分支，已并入原 pi-header）。Codex 样式状态栏自动查询 Sub2API 或 New API；`/balance` 手动刷新。New API 默认显示当前 API 令牌剩余额度，无限额度显示 `∞`；站点允许返回 `user_quota` 时显示账户余额。无需配置 provider 名称；接口不支持或权限拒绝时隐藏余额。
  - 上下文百分比随每个流式增量刷新；提供商尚未上报用量时采用估算。UA 标签仅显示首个 `/` 前的内容；不含 `/` 时保留完整内容，终端宽度不足时裁剪。
- `pi-companion`（合并自 pi-shortcuts + pi-guard：快捷指令 /plan /clear /ralph /loop /rules /claude /plugin-create-mode + 响应守卫 + 建议旁观者 + 内置 claude-driver skill）
- `@narumitw/pi-goal`（所有 `/goal` 提示词——启动、目标更新、恢复、自动续跑及活动目标系统提示——共用代码修改的禁止回归条款：保留现有功能，执行受影响的既有测试，禁止删除或弱化断言，失败先修复再交付，报告风险、验证与恢复方案）；同一入口追加禁止模型调用 `dispatch_agent backend="controlled-pi"` 的提示词规则，省略 `backend` 也禁止调用。任务由主线程完成，禁止通过其他工具、别名或外部进程绕过。该规则不移除工具注册，不改变用户显式命令
- `pi-web-access`（Web 搜索、提取与内容整理工具：/websearch、/curator、/google-account、/search）
- `pi-hashline-edit-pro`
- `@gamaraan/todos-tool`（结构化 todo 追踪：todo 工具维护计划清单并以实时 HUD 显示在编辑器上方，另含 /todo 与 /todos-configure 命令）
- `pi-agent`（本地打包自 @giladbarnea/pi-user-agents：默认由主 Agent 按目标主动分派独立任务，带实时进度挂件；简单任务直接执行，无需用户选择拆分命令；支持 `/agent -P/--plan` 以后台方式执行规划；一键预设命令 `/spawn` `/scout` `/blueprint`；另提供 `/dispatch` 命令与 `dispatch_agent` 工具，由主 Agent 智能批量分发任务）
- `/agent` 支持通过父审批桥继承全部已启用工具；新增子任务 `outputSchema` 结果校验，以及 `lsp` 诊断、定义、引用和悬浮查询。支持一次批量派发及短角色模板，子任务不设执行超时；新增 AST 查询/预览/编辑和 Node 断点调试。详情见 [pi-agent](plugin/pi-agent/README.md)。
- 派发入口统一为 `dispatch_agent`；`manage_agent` 仅保留 `status`、`wait`、`interrupt`、`close` 生命周期及批次管理，新增跨重启 `history` 查询。旧 `pi-subagents` 加载及 supervisor 工具已禁用。
- `pi-memory`（单 JSON 文件持久化跨会话记忆：/memory save|list|find|remove|recall|clear；零原生依赖）
- `pi-remote-control`（显式 `/remote on` 绑定当前会话，配合腾讯 OpenClaw 微信插件远程执行；[配置说明](docs/features/wechat-openclaw-control.md)）
- `@ff-labs/pi-fff`（仅桌面端：带频率排序的 FFF 文件搜索；Android 与 Windows 不包含）

## 定时循环 `/loop`

```text
/loop 5m 检查部署状态
/loop 检查当前 PR 的 CI 与审查评论
/loop 15m
/loop list
/loop cancel <id>
/loop cancel all
```

指定间隔时按 cron 运行；省略间隔时由模型在每轮结束选择下一次等待时间（1 分钟至 1 小时）。省略提示词时读取项目 `.pi/loop.md` 或用户 `~/.pi/agent/loop.md`，兼容 `.claude/loop.md`；没有文件则继续未完成工作、维护当前 PR、检查缺陷。

任务仅在会话运行且空闲时触发，忙时合并错过的周期。固定任务支持恢复原会话，动态循环需重新启动；循环七天后过期。提供 `CronCreate`、`CronList`、`CronDelete`、`ScheduleWakeup` 工具，支持自然语言创建、查看、取消或单次提醒。动态等待时空输入按 `Esc` 或 `Ctrl+C` 可停止，固定任务通过取消命令停止。设置 `AXUM_DISABLE_CRON=1` 关闭调度。实现见[循环调度源码](plugin/pi-companion/loop.ts)。

## 环境要求

- **Node.js** >= 22.19.0
- **npm** >= 9
- macOS、Linux 或 Windows 终端，亦支持 Android/Termux。
- 一个 OpenAI 兼容的 API Key（或在 Web UI 中配置任意 Provider）。

## 快速开始

从 main 分支 tarball 全局安装 Axum:

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

直接启动代理:

```bash
axum
```

在 Web 界面配置 Provider 与 System Prompt:

```bash
axum web
```

在浏览器中聊天（内置 pi-web 界面，与 `axum code` 共享 provider 与会话）:

```bash
axum chat
```

启动代理:

```bash
axum code
```

> 提示：在仓库检出目录里，直接运行 `node bin/axum.js code`（或全局安装的 `code` 命令）可以跳过 `npm run` 包装层，每次启动约省 0.2 秒。

若打包扩展导致启动失败，可进入安全模式启动，该模式不加载任何打包扩展:

```bash
axum code --safe
```

健康检查:

```bash
axum --version
axum doctor
```

桌宠默认不显示。在交互终端输入 `/pet` 打开。重载或切换会话后，需再次输入 `/pet` 才会显示。设置 `AXUM_DESKTOP_PET=0` 可禁用该命令。

## 安装额外扩展

```bash
axum install npm:pi-foo@1.0.0
axum uninstall pi-foo
```

`install` 复用打包集同一套缓存管线获取指定的 npm 包，记录到 `~/.axum/packages.json`（可用 `AXUM_USER_PACKAGES_FILE` 覆盖），编译其扩展入口，并在下一次 `axum code` 启动时加载。包名与打包集重复会被拒绝，这些版本由 Axum 统一管理；安装中途失败时清单会回滚到先前状态。Windows 下建议选择可安全剥离的 TypeScript 扩展（不含装饰器、enum 等内置剥离器无法处理的语法），因为 Windows 依赖内置剥离器而不是本地 `tsc`。仅加载包 `pi.extensions` 列表中的第一个入口。

## MCP 服务

MCP 支持内置于打包的 Pi 运行时（0.99+），无需安装任何扩展。添加一个服务即可使用：

```bash
axum mcp add        # 交互式：服务名、stdio 命令或 http(s) url、args、env
axum mcp list       # 列出已配置的服务
axum mcp remove <name>
```

在 `axum code` 会话内运行 `/mcp`，可查看连接状态并管理服务。

服务配置存于与 Cursor、Claude Code、Codex 通用的标准 `mcpServers` JSON 格式，写入 Pi 原生读取的位置：项目 `.pi/mcp.json` 或用户级 `~/.pi/agent/mcp.json`。项目文件存在时优先使用；`axum mcp add` 的 `--project` / `--global` 可强制指定其中一个文件。stdio 服务的命令行可携带参数：首个词作为 `command`，其余存入 `args`。`axum doctor` 会报告配置文件是否为合法 JSON，并在检测到旧版 pi-mcp-adapter 扩展残留时告警——它会替换内建的 `/mcp`。

## 配置 Provider

从「快速开始」中的 `axum web` 的 Provider 标签页保存。

输入项:

- **API 协议**。`openai-completions`（默认）为 OpenAI 兼容协议，可用于任意兼容端点。`anthropic-messages` 走 Anthropic 原生协议（base URL 填不带 `/v1` 的 `https://api.anthropic.com`）；该端点不提供模型列表，请从预设候选选择或手动输入模型 ID。
- **Base URL**，例如 `https://api.moonshot.cn/v1`
- **API Key**
- **Model**，没有 `/models` 端点的 provider 可手动输入。
- **上下文窗口**按模型确定：已保存值（含 `/ctx` 设置）> `/models` 元数据 > 内置目录精确匹配值 > 所选预设 > 128000 token 回退值。未知模型未提供元数据时仍使用 128000；在 `axum code` 中用 `/ctx <tokens>` 设置实际上限。不会自动迁移已有提供商。
- **参考预设**（可选）。Anthropic（`https://api.anthropic.com`，原生协议）与 OpenAI Chat（`https://api.openai.com/v1`）一键模板，按厂商默认值填好 API 协议、base URL、提供商名、token 上限与模型候选，补上 API Key 并选择模型即可保存。

保存位置:

- `~/.pi/agent/models.json`
- `~/.pi/agent/axum.json`

保存后重新启动代理:

```bash
axum code
```

为兼容性考虑，`openai-completions` 形态的 provider 默认 `supportsDeveloperRole=false` / `supportsReasoningEffort=false`（`anthropic-messages` 形态的兼容性交给 pi-ai 处理）。

**Codex Responses 网关兼容。** `axum code` 和 `axum chat` 的所有 `openai-responses` / `openai-codex-responses` 适配器入口都发送非空的顶层 `prompt_cache_key`，优先级：`axum.json` 根字段 > SDK `sessionId` > 临时 UUID v4。保留 SDK 会话 ID 及其 UUID 版本：多轮、重试、恢复会话复用键；new/reset 新会话换键，配置固定覆盖值时除外。`cacheRetention: "none"` 仍保留此路由粘性键。这是网关兼容修复，公共 OpenAI Responses API 并非通用必填此字段。尚未执行真实线上网关验证。

将可选根字段合入 `${PI_CODING_AGENT_DIR}/axum.json`（默认 `~/.pi/agent/axum.json`），重启 `axum code` / `axum chat` 加载。省略 `prompt_cache_key` 即自动使用会话键；示例显式固定路由：

```json
{
  "prompt_cache_key": "my-gateway-route",
  "userAgent": "my-client/1.0",
  "codexHeaders": {
    "originator": "codex_cli_rs"
  }
}
```

请求头优先级：请求 `options.headers` > `model.headers` > 根字段 `codexHeaders` > 默认值。User-Agent 选择顺序：`AXUM_USER_AGENT` > 根字段 `userAgent` > `codex_cli_rs/0.125.0 (OS version; arch) TERM`，默认值使用真实系统版本、架构和终端标识；默认 `originator` 为 `codex_cli_rs`。`codexHeaders` 也支持 `OpenAI-Beta`：HTTP 默认不强加旧值 `responses=experimental`；WebSocket 保留 SDK 协议 Beta，可由配置或更高优先级请求头覆盖。

## 重试设置

在 `axum web` 的重试标签页配置 API 请求失败时的自动重试策略（启动方式见「快速开始」）。

配置项:

- **启用重试** —— 默认关闭。Pi 本体默认开启，但 Axum 要求显式启用。
- **最大重试次数** —— 默认 `3`。
- **基础退避延迟 (ms)** —— 默认 `2000`。指数退避: `baseDelayMs * 2^(attempt-1)`。

重试目标为过载、限流、服务器错误。上下文超长**不在**重试范围内（由压缩处理）。

保存位置:

- `~/.pi/agent/settings.json`

## 编辑 System Prompt

在 `axum web` 的 System Prompt 标签页编辑（启动方式见「快速开始」）。

默认:

```text
~/.pi/agent/SYSTEM.md
```

目标:

- **全局 `SYSTEM.md`** —— 默认，替换标准 prompt。
- **全局 `APPEND_SYSTEM.md`** —— 追加到标准 prompt。
- **项目 `APPEND_SYSTEM.md`** —— `<cwd>/.pi/APPEND_SYSTEM.md`。
- **项目 `SYSTEM.md`** —— `<cwd>/.pi/SYSTEM.md`。

保存前会显示 diff。若文件被外部修改则拒绝保存。

保存后，同一会话的下一次模型请求会自动使用最新规则，包括工具执行后的续轮，无需重启会话或执行 `/reload`。已经发出的请求不受影响。项目级规则继续遵循 Pi 原有的信任与优先级规则。

## 自定义 `/plan` Prompt

`/plan` 支持用户级 prompt 覆盖文件：

```text
~/.pi/agent/plan-prompt.md
```

规则：

- 文件不存在时，Axum 回退到内置 `/plan` prompt。
- 文件存在时，Axum 直接使用其中内容作为 `/plan` 模板。
- 文件必须包含占位符 `{{requirement}}`，这样 Axum 才知道把用户需求插到哪里。
- 如果文件存在但为空，或不包含 `{{requirement}}`，`/plan` 会直接报错，而不是发送损坏的 prompt。

也可以在 axum web 设置页编辑该文件：打开 **设置 → System Prompt**，把模式下拉切换到 `plan-prompt.md（/plan 模板）`。网页编辑器会强制校验同样的 `{{requirement}}` 规则，并提供“恢复内置模板”按钮删除该文件，让 `/plan` 回退到内置 prompt。

示例：

```md
[Requirement]
{{requirement}}

[Objective]
讨论并敲定技术方案：把方案细节讲清楚、把实现方式讲清楚，并整理出一份切实可执行的计划，同时用一句平实的语言说明预期结果。

[Rules]

1. 仅做只读调研；不要修改文件、不要写代码，也不要给出代码片段。
2. 只有当我明确说“生成”（generate）时才执行实现；否则保持在调研与讨论模式。
3. 请用简单直白的语言，清楚说明当前阶段希望达成的具体结果。
```

## 一键后台 Agent

目标有两个或更多值得并行的独立文件、模块或验证通道时，主 Agent 应尽早派发，提供上下文、独占文件范围、接口与验收条件，并自行推进关键路径。主 Agent 收集结果、修复遗漏或冲突并统一验证；简单或紧耦合任务内联完成。共享文件归单一负责人，依赖通道等待前置证据。这是模型策略，不是确定性调度器。新需求应先检查已有副作用，再另派增量任务，不续跑旧任务。

三条预设命令固化了 `/agent` 的高频参数组合，发起后台任务零参数决策：

```text
/spawn fix the login bug        # 等价 /agent -s fix the login bug
/scout why does the build fail  # 等价 /agent -i why does the build fail
/blueprint add dark mode        # 等价 /agent -P -s add dark mode
```

- `/spawn <任务>` —— 派发独立的一次性任务，完成后结果自动回投主会话；必须明确提供必要上下文。
- `/scout <任务>` —— 派发独立的一次性调研任务，不继承会话历史。
- `/blueprint <任务>` —— 以后台计划模式运行，完成后自动原样回投成稿方案。

追加参数仍可组合：`/spawn -m gpt-5 …` 有效，因为预设只是共享 `/agent` 解析器、挂件与生命周期之上的参数前缀。`/agent [options] <任务>` 同样遵循一次性任务契约。

## 用 `/usemodel` 切换模型

`/usemodel` 读取 `~/.pi/agent/models.json` 中配置的模型，打开交互式选择器，列出所有 provider 的所有模型并标注当前默认：

```text
/usemodel            # 打开模型选择器
```

每一项以 `provider/model` 显示，默认模型带 `  (default)` 标记。任选一个模型即可立即切换。
切换仅作用于当前会话，不会修改 `~/.pi/agent/settings.json` 中的 `defaultProvider`/`defaultModel`，因此不会影响其他正在运行的会话或之后新开的会话。

支持图像的模型需在 `models.json` 声明 `"input": ["text", "image"]`。编辑提供商会保留该字段；伴随扩展会在输入与工具调用前刷新能力。图片直接交给当前模型，移除 `/vision` 备用视觉路由。

## Doctor

```bash
axum doctor
```

`doctor` 检查打包 Pi 缓存与入口点，并报告用户自装扩展的健康状态（含 MCP 配置文件是否为合法 JSON；若检测到旧版 pi-mcp-adapter 扩展会替换内建 `/mcp`，则给出告警）。

安全模式（`axum code --safe`）仅启动 Pi 本体，不加载上述打包扩展。


打包 Pi 运行时存储于用户缓存，而非 npm 全局包目录。因此重新安装 Axum 通常不会重复执行 `axum code` 的首次安装流程。

## 更新

```bash
axum update
```

用 GitHub main 分支的 tarball 重新安装 npm 全局包。通常无需重新执行首次安装流程。

## License

Axum Agent 采用 **FSL-1.1-ALv2** 许可证：Functional Source License, Version 1.1, ALv2 Future License。未来许可授予为 Apache License 2.0。详见 [LICENSE](./LICENSE)。

## 翻译

- [English](./README.md)
- [日本語](./README.ja.md)
- [中文](./README.zh-CN.md)（当前）
