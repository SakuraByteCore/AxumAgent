# Axum Agent

Axum Agent 是一个基于 Pi 的编码代理分发包，将 Pi 本体与扩展一同打包并启动。

打包运行时:

- `@earendil-works/pi-coding-agent`
- `pi-bar`（AxumAgent 打包分支）
- `pi-header`（AxumAgent 打包分支）
- `@narumitw/pi-goal`

## 快速开始

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

```bash
axum
```

在 Web 界面配置 Provider 与 System Prompt:

```bash
axum web
```

启动代理:

```bash
axum code
```

若打包扩展导致启动失败，可进入安全模式启动，该模式不加载任何打包扩展:

```bash
axum code --safe
```

健康检查:

```bash
axum doctor
```

## 配置 OpenAI 兼容 Provider

从「快速开始」中的 `axum web` 的 Provider 标签页保存。

输入项:

- Base URL，例如 `https://api.moonshot.cn/v1`
- API Key
- Model，没有 `/models` 端点的 provider 可手动输入

保存位置:

- `~/.pi/agent/models.json`
- `~/.pi/agent/axum.json`

保存后:

```bash
axum code
```

为兼容性考虑，OpenAI 兼容 provider 默认 `supportsDeveloperRole=false` / `supportsReasoningEffort=false`。

## 重试设置

在 `axum web` 的重试标签页配置 API 请求失败时的自动重试策略（启动方式见「快速开始」）。

配置项:

- 启用重试 — 默认关闭。Pi 本体默认开启，但 Axum 要求显式启用
- 最大重试次数 — 默认 3
- 基础退避延迟 (ms) — 默认 2000。指数退避: `baseDelayMs * 2^(attempt-1)`

重试目标为过载、限流、服务器错误。上下文超长不在重试范围内（由压缩处理）。

保存位置:

- `~/.pi/agent/settings.json`

## 编辑 System Prompt

在 `axum web` 的 System Prompt 标签页编辑（启动方式见「快速开始」）。

默认:

```text
~/.pi/agent/SYSTEM.md
```

目标:

- Global `SYSTEM.md` — 默认，替换标准 prompt
- Global `APPEND_SYSTEM.md` — 追加到标准 prompt
- Project `APPEND_SYSTEM.md` — `<cwd>/.pi/APPEND_SYSTEM.md`
- Project `SYSTEM.md` — `<cwd>/.pi/SYSTEM.md`

保存前会显示 diff。若文件被外部修改则拒绝保存。

## Doctor

```bash
axum doctor
```

`doctor` 检查打包 Pi 缓存与入口点。
若扩展问题导致无法正常启动，可使用 `axum code --safe`，仅以 `-ne` 启动 Pi 本体，不加载 `pi-bar` / `pi-goal` / `pi-header`。

打包 Pi 运行时存储于用户缓存，而非 npm 全局包目录。因此重新安装 Axum 通常不会重复执行 `axum code` 的首次安装流程。

## 更新

```bash
axum update
```

用 GitHub main 分支的 tarball 重新安装 npm 全局包。通常无需重新执行首次安装流程。

## License

FSL-1.1-ALv2: Functional Source License, Version 1.1, ALv2 Future License. The future license grant is Apache License 2.0. See [LICENSE](./LICENSE).

---

翻译: [English](./README.md) | [日本語](./README.ja.md)
