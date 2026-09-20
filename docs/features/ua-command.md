# User-Agent 配置命令技术变更说明

### 问题
用户需要在 `npm run code` 会话内通过 `/ua` 命令动态切换 User-Agent，以便在不同场景下模拟不同 CLI 客户端（Codex CLI、Claude Code）的请求头，并支持动态添加新预设。

### 原因
不同的 API 提供商可能根据 User-Agent 字段返回不同的响应格式、配额策略或功能开关。通过支持会话内动态切换 User-Agent，用户可以：
- 在同一会话中测试不同客户端身份下的 API 行为
- 无需重启 CLI 即可切换客户端标识
- 通过配置文件动态添加新的 UA 预设，支持热重载

### 修改点

#### 1. 配置读写函数 (`src/provider-config.js`)
- 新增 `getUserAgent(file)` 函数：从 `~/.pi/agent/axum.json` 读取当前配置的 User-Agent
- 新增 `saveUserAgent(userAgent, file)` 函数：将 User-Agent 持久化到配置文件
- 新增 `getUAPresets(file)` 函数：从配置文件读取 UA 预设列表，支持热重载
- 新增 `addUAPreset(key, name, value, file)` 函数：向配置文件添加新的 UA 预设
- 内部 `getDefaultUAPresets()` 函数：提供默认预设（Codex CLI、Claude Code）

#### 2. 配置文件结构 (`~/.pi/agent/axum.json`)
扩展配置文件结构，支持预设列表：
```json
{
  "userAgent": "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color",
  "presets": [
    { "key": "codex", "name": "Codex CLI", "value": "codex_cli_rs/0.125.0 ..." },
    { "key": "claude", "name": "Claude Code", "value": "claude-code-cli/1.0.0" },
    { "key": "myapp", "name": "My Custom App", "value": "MyApp/1.0.0" }
  ]
}
```

#### 3. Pi 扩展命令 (`plugin/pi-companion/index.ts`)
- 在 `pi.registerCommand()` 中注册 `/ua` 会话内命令
- 实现配置文件驱动的预设列表，每次调用时动态加载
- 支持数字索引和关键词两种输入方式：
  - 数字索引：`/ua 1` (第一个预设), `/ua 2` (第二个预设)
  - 关键词：`/ua codex`, `/ua claude`, `/ua myapp`
- 移除 custom 和 reset 选项，只保留预设模式
- 无参数时显示当前 UA 和可用预设列表
- 通过 `ctx.ui.notify()` 显示操作结果反馈

#### 4. Provider 注入 (`src/provider-web.js`)
- 在 `testModelAvailability()` 函数的 `doFetch` 内部调用 `getUserAgent()` 读取配置
- 在发起 `fetch()` 请求前，将自定义 User-Agent 注入到 headers 中
- 如果 `getUserAgent()` 返回 `null`，则不注入，使用 Node.js 默认 User-Agent

### 预期结果

#### 命令使用示例
```bash
# 查看当前 UA 和可用预设
/ua

# 切换到第一个预设（数字索引）
/ua 1

# 切换到 Codex CLI（关键词）
/ua codex

# 切换到 Claude Code
/ua 2
/ua claude

# 切换到自定义预设（假设已添加）
/ua myapp
```

#### 会话内反馈
切换成功后，Pi 会显示通知：
```
✓ UA switched to Codex CLI
```

查看当前配置：
```
Current: codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color

Usage: /ua [key]
Available presets:
  1 or codex  - Codex CLI
  2 or claude - Claude Code
  3 or myapp  - My Custom App
```

#### 动态添加预设
通过 `src/provider-config.js` 的 `addUAPreset()` 函数，可以在运行时动态添加新预设：

```javascript
// 在 npm run web 或其他脚本中调用
import { addUAPreset } from './src/provider-config.js';

addUAPreset('myapp', 'My Custom App', 'MyApp/1.0.0');
```

添加后，下次调用 `/ua` 即可看到新预设，无需重启任何服务。

#### 配置持久化
配置保存在 `~/.pi/agent/axum.json`：
```json
{
  "userAgent": "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color",
  "presets": [
    { "key": "codex", "name": "Codex CLI", "value": "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color" },
    { "key": "claude", "name": "Claude Code", "value": "claude-code-cli/1.0.0" }
  ]
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

**为什么采用配置文件驱动的预设列表？**

最初实现使用硬编码预设列表，但这导致：
1. 添加新预设需要修改代码并重启服务
2. `plugin/pi-companion/index.ts` 和 `src/provider-config.js` 需要双重维护
3. 无法支持运行时动态扩展预设

**配置文件驱动方案优势：**
- **真正的热重载**：添加新预设后，下次 `/ua` 调用立即可见，无需重启
- **单一配置源**：预设列表存储在配置文件中，避免双重维护
- **脚本化扩展**：通过 `addUAPreset()` 函数，支持在 `npm run web` 或其他脚本中动态添加预设
- **简化管理**：移除 custom 和 reset 选项后，所有 UA 都是预设，统一管理更清晰

**为什么移除 custom 和 reset 选项？**

- **custom**：临时自定义 UA 不可复用，改为通过 `addUAPreset()` 添加持久预设
- **reset**：恢复默认实际上就是切换到默认预设，无需单独选项
- 统一为预设模式后，所有 UA 都可复用、可管理、可热重载
