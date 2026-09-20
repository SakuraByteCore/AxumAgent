# User-Agent 配置命令技术变更说明

### 问题
用户需要在 `npm run code` 会话内通过 `/ua` 命令动态切换 User-Agent，以便在不同场景下模拟不同 CLI 客户端（Codex CLI、Claude Code）的请求头。

### 原因
不同的 API 提供商可能根据 User-Agent 字段返回不同的响应格式、配额策略或功能开关。通过支持会话内动态切换 User-Agent，用户可以：
- 在同一会话中测试不同客户端身份下的 API 行为
- 无需重启 CLI 即可切换客户端标识
- 通过交互式菜单快速选择预设或自定义 UA

### 修改点

#### 1. 配置读写函数 (`src/provider-config.js`)
- 新增 `getUserAgent(file)` 函数：从 `~/.pi/agent/axum.json` 读取当前配置的 User-Agent
- 新增 `saveUserAgent(userAgent, file)` 函数：将 User-Agent 持久化到配置文件

#### 2. Pi 扩展命令 (`plugin/pi-companion/index.ts`)
- 在 `pi.registerCommand()` 中注册 `/ua` 会话内命令
- 实现 4 个预设选项的交互式选择菜单：
  - Codex CLI: `codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color`
  - Claude Code: `claude-code-cli/1.0.0`
  - Custom (手动输入)：弹出文本输入框
  - Reset (恢复默认)：清空配置，使用 Node.js 默认 UA
- 使用 `prompts` 库实现交互式选择和文本输入
- 通过 `ctx.ui.notify()` 显示操作结果反馈

#### 3. Provider 注入 (`src/provider-web.js`)
- 在 `testModelAvailability()` 函数的 `doFetch` 内部调用 `getUserAgent()` 读取配置
- 在发起 `fetch()` 请求前，将自定义 User-Agent 注入到 headers 中
- 如果 `getUserAgent()` 返回 `null`，则不注入，使用 Node.js 默认 User-Agent

### 预期结果

#### 会话内交互
用户在 `npm run code` 会话中输入 `/ua` 并按回车后，看到四选一的交互式菜单：
```
? 选择 User-Agent › - Use arrow-keys. Return to submit.
❯ Codex CLI
  Claude Code
  Custom (手动输入)
  Reset (恢复默认)
```

选择 Codex CLI 或 Claude Code 后，配置立即生效并持久化到 `~/.pi/agent/axum.json`：
```json
{
  "userAgent": "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color"
}
```

选择 Custom 时，弹出文本输入框让用户手动输入自定义 User-Agent 字符串。

选择 Reset 时，配置被清空（设为 `null`），后续 API 请求使用 Node.js 默认 User-Agent。

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
