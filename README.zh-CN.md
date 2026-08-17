# Axum Agent

<p align="center">
  <a href="./LICENSE"> <img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat-square" alt="License"> </a>
  <a href="https://nodejs.org"> <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square" alt="Node"> </a>
</p>

> 基于 Pi 的编码代理分发包，将 Pi 本体与精选扩展一同打包并启动。

Axum Agent 是一个基于 Pi 的编码代理分发包。它将 Pi 本体与扩展一同打包并启动，只需一条 `npm install -g` 即可获得开箱即用的代理，无需额外接线。

- **一键安装** —— 从 main 分支 tarball 安装全局 npm 包，无需 clone 或构建。
- **打包扩展** —— Pi 本体与一组精选扩展同装同启。
- **Web 配置** —— Provider、重试与系统提示词设置均在本地 Web UI 完成。
- **安全模式** —— 任何损坏的扩展都可被跳过，仅启动 Pi 本体。
- **自包含运行时** —— 打包的 Pi 运行时存于用户缓存，重装 Axum 不会重复首次安装流程。

## 目录

- [打包运行时](#打包运行时)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置 OpenAI 兼容 Provider](#配置-openai-兼容-provider)
- [重试设置](#重试设置)
- [编辑 System Prompt](#编辑-system-prompt)
- [Doctor](#doctor)
- [更新](#更新)
- [License](#license)
- [翻译](#翻译)

## 打包运行时

本分发包含以下包，一次安装全部就位:

- `@earendil-works/pi-coding-agent`
- `pi-bar`（AxumAgent 打包分支）
- `pi-header`（AxumAgent 打包分支）
- `pi-shortcuts`（合并自 pi-plan + pi-clear）
- `@narumitw/pi-goal`
- `pi-response-guard`
- `pi-guard`
- `@agwab/pi-workflow`

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

- **Base URL**，例如 `https://api.moonshot.cn/v1`
- **API Key**
- **Model**，没有 `/models` 端点的 provider 可手动输入。

保存位置:

- `~/.pi/agent/models.json`
- `~/.pi/agent/axum.json`

保存后重新启动代理:

```bash
axum code
```

为兼容性考虑，OpenAI 兼容 provider 默认 `supportsDeveloperRole=false` / `supportsReasoningEffort=false`。

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

## Doctor

```bash
axum doctor
```

`doctor` 检查打包 Pi 缓存与入口点。

若扩展问题导致无法正常启动，可使用 `axum code --safe`，仅以 `-ne` 启动 Pi 本体，不加载 `pi-bar` / `pi-header` / `pi-shortcuts` / `pi-goal` / `pi-response-guard` / `pi-guard` / `pi-workflow` 。

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
