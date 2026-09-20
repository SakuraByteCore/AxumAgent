# User-Agent 配置命令技术变更说明

### 问题
用户需要在 `npm run code` 会话内通过 `/ua` 命令动态切换 User-Agent，以便在不同场景下模拟不同 CLI 客户端（Codex CLI、Claude Code）的请求头。

### 原因
不同的 API 提供商可能根据 User-Agent 字段返回不同的响应格式、配额策略或功能开关。通过支持会话内动态切换 User-Agent，用户可以：
- 在同一会话中测试不同客户端身份下的 API 行为
- 无需重启 CLI 即可切换客户端标识
- 快速选择预设或设置自定义 UA

### 修改点

#### 1. 配置读写函数 (`src/provider-config.js`)
- 新增 `getUserAgent(file)` 函数：从 `~/.pi/agent/axum.json` 读取当前配置的 User-Agent
- 新增 `saveUserAgent(userAgent, file)` 函数：将 User-Agent 持久化到配置文件

#### 2. Pi 扩展命令 (`plugin/pi-companion/index.ts`)
- 在 `pi.registerCommand()` 中注册 `/ua` 会话内命令
- 实现参数化接口，支持 8 种输入方式：
  - 数字选项：`/ua 1` (Codex CLI), `/ua 2` (Claude Code), `/ua 3` (Custom), `/ua 4` (Reset)
  - 关键词选项：`/ua codex`, `/ua claude`, `/ua custom`, `/ua reset`
  - 自定义 UA：`/ua custom <your-user-agent-string>`
  - 查看帮助：`/ua`（无参数时显示当前 UA 和使用说明）
- 通过 `ctx.ui.notify()` 显示操作结果反馈
- 避免使用 `prompts` 交互式 UI，防止与 Pi 底部状态栏终端渲染冲突

#### 3. Provider 注入 (`src/provider-web.js`)
- 在 `testModelAvailability()` 函数的 `doFetch` 内部调用 `getUserAgent()` 读取配置
- 在发起 `fetch()` 请求前，将自定义 User-Agent 注入到 headers 中
- 如果 `getUserAgent()` 返回 `null`，则不注入，使用 Node.js 默认 User-Agent

### 预期结果

#### 命令使用示例
```bash
# 查看当前 UA 和帮助
/ua

# 切换到 Codex CLI（数字或关键词）
/ua 1
/ua codex

# 切换到 Claude Code
/ua 2
/ua claude

# 设置自定义 UA
/ua custom MyApp/1.0.0

# 恢复默认
/ua 4
/ua reset
```

#### 会话内反馈
切换成功后，Pi 会显示通知：
```
✓ UA switched to Codex CLI
```

查看当前配置：
```
Current: codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color

Usage: /ua [option]
  1 or codex  - Codex CLI
  2 or claude - Claude Code
  3 or custom - Custom (prompt for input)
  4 or reset  - Reset to default
```

#### 配置持久化
配置保存在 `~/.pi/agent/axum.json`：
```json
{
  "userAgent": "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color"
}
```

#### API 请求注入
`npm run web` 启动的 HTTP 服务器在调用 `/models` 和 `/chat/completions` 等上游 API 时，自动读取配置并注入 `User-Agent` header：
```javascript
fetch(endpoint, {
  headers: {
    "User-Agent": "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color",
    "Authorization": "Bearer sk-...",
    ...
  }
})
```

切换后的 UA 对当前会话及后续所有 API 请求生效，无需重启 `npm run code` 或 `npm run web`。

### 技术决策

**为什么不使用 `prompts` 交互式选择？**

最初尝试使用 `prompts` 库实现交互式菜单，但遇到终端 UI 冲突：
- `prompts` 使用 ANSI 转义序列直接操作 `process.stdout` 控制光标和清屏
- Pi CLI 的底部状态栏也使用 ANSI 转义序列固定在终端底部
- 两者在同一输出流上渲染导致光标定位混乱，状态栏显示错位

**参数化方案优势：**
- 零终端 UI 冲突，与 Pi 状态栏和平共处
- 实现简单、可靠，符合 Pi 命令惯用模式（如 `/plan <requirement>`）
- 支持数字和关键词双重输入方式，兼顾简洁和可读性
- `/ua` 命令使用频率不高，参数化输入完全够用
