# Axum Agent

<p align="center">
  <a href="./LICENSE"> <img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat-square" alt="License"> </a>
  <a href="https://nodejs.org"> <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square" alt="Node"> </a>
</p>

> Pi ベースのコーディングエージェント配布パッケージ。Pi 本体と厳選拡張を同梱して起動します。

Axum Agent は、Pi ベースのコーディングエージェント配布パッケージです。Pi 本体と拡張を同梱して起動するため、`npm install -g` 1 本で追加設定なしにすぐ動くエージェントが手に入ります。

- **ワンコマンドでインストール** —— main ブランチの tarball からグローバル npm パッケージをインストール。clone も build も不要。
- **同梱拡張** —— Pi 本体と厳選した拡張セットを一緒に同梱・同時起動。
- **Web での設定** —— provider・リトライ・システムプロンプトの設定はローカル Web UI で完結。
- **セーフモード** —— 壊れた拡張はスキップし、Pi 本体だけを起動可能。
- **自己完結ランタイム** —— 同梱 Pi ランタイムはユーザーキャッシュに保存され、Axum を再インストールしても first-run setup は繰り返しません。

## 目次

- [同梱ランタイム](#同梱ランタイム)
- [要件](#要件)
- [クイックスタート](#クイックスタート)
- [OpenAI 互換 provider の設定](#openai-互換-provider-の設定)
- [リトライ設定](#リトライ設定)
- [System Prompt の編集](#system-prompt-の編集)
- [Doctor](#doctor)
- [更新](#更新)
- [License](#license)
- [翻訳](#翻訳)

## 同梱ランタイム

本配布版には以下のパッケージが同梱され、1 回のインストールで全て揃います:

- `@earendil-works/pi-coding-agent`
- `pi-bar` (AxumAgent 同梱フォーク)
- `pi-header` (AxumAgent 同梱フォーク)
- `pi-guard` (AxumAgent 同梱フォーク)
- `pi-clear` (AxumAgent 同梱フォーク)
- `@narumitw/pi-goal`
- `@gotgenes/pi-subagents`
- `pi-task`
- `pi-plan`

## 要件

- **Node.js** >= 22.19.0
- **npm** >= 9
- macOS・Linux・Windows のターミナル。Android/Termux も対応。
- OpenAI 互換の API キー（または Web UI で設定する任意の provider）。

## クイックスタート

main ブランチの tarball から Axum をグローバルインストール:

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

そのままエージェントを起動:

```bash
axum
```

Provider と System Prompt を Web で設定します:

```bash
axum web
```

エージェントを起動します:

```bash
axum code
```


拡張が壊れて起動できない場合は、bundled extensions を一切読み込まないセーフモードで起動できます:

```bash
axum code --safe
```

状態確認:

```bash
axum doctor
```

## OpenAI 互換 provider の設定

「クイックスタート」の `axum web` から Provider tab で保存します。

入力項目:

- **Base URL**。例: `https://api.moonshot.cn/v1`
- **API Key**
- **Model**。`/models` がない provider は手入力できます。

保存先:

- `~/.pi/agent/models.json`
- `~/.pi/agent/axum.json`

保存後、エージェントを再起動:

```bash
axum code
```

互換性のため、OpenAI 互換 provider は `supportsDeveloperRole=false` / `supportsReasoningEffort=false` を既定にします。

## リトライ設定

`axum web` のリトライ tab で、API リクエスト失敗時の自動リトライ戦略を設定します（起動方法は「クイックスタート」参照）。

設定項目:

- **リトライ有効化** —— 既定は無効。Pi 本体の既定は有効だが、Axum は明示的な有効化を要求する。
- **最大リトライ回数** —— 既定 `3`。
- **基底バックオフ遅延 (ms)** —— 既定 `2000`。指数バックオフ: `baseDelayMs * 2^(attempt-1)`。

リトライ対象は過負荷・レート制限・サーバーエラー。コンテキスト超過はリトライ対象外（圧縮で処理）。

保存先:

- `~/.pi/agent/settings.json`

## System Prompt の編集

`axum web` の System Prompt tab で編集します（起動方法は「クイックスタート」参照）。

既定:

```text
~/.pi/agent/SYSTEM.md
```

対象:

- **グローバル `SYSTEM.md`** —— 既定。標準 prompt を置換。
- **グローバル `APPEND_SYSTEM.md`** —— 標準 prompt に追記。
- **プロジェクト `APPEND_SYSTEM.md`** —— `<cwd>/.pi/APPEND_SYSTEM.md`。
- **プロジェクト `SYSTEM.md`** —— `<cwd>/.pi/SYSTEM.md`。

保存前に diff を表示します。ファイルが外部で変更されていた場合は保存を拒否します。

## Doctor

```bash
axum doctor
```

`doctor` は bundled Pi cache と entrypoint を確認します。

拡張の問題で通常起動できない場合は `axum code --safe` を使うと、Pi 本体だけを `-ne` で起動し、`pi-bar` / `pi-header` / `pi-guard` / `pi-clear` / `pi-goal` / `pi-subagents` / `pi-task` / `pi-plan` を読み込みません。

Bundled Pi ランタイムは npm の global package ディレクトリではなく、ユーザーキャッシュに保存されます。そのため、Axum を再インストールしても通常は `axum code` の first-run setup を繰り返しません。

## 更新

```bash
axum update
```

GitHub の main ブランチの tarball で npm グローバルを再インストールします。通常は first-run setup の再実行不要です。

## License

Axum Agent は **FSL-1.1-ALv2** ライセンスで公開されています: Functional Source License, Version 1.1, ALv2 Future License。将来のライセンス付与は Apache License 2.0 です。詳しくは [LICENSE](./LICENSE) を参照してください。

## 翻訳

- [English](./README.md)
- [日本語](./README.ja.md)（現在）
- [中文](./README.zh-CN.md)
