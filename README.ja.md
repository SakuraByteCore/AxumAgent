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
- `pi-bar`（AxumAgent 同梱フォーク、旧 pi-header を統合）
- `pi-companion`（pi-shortcuts + pi-guard を統合: ショートカット + レスポンスガード + アドバイザリウォッチャー）
- `@narumitw/pi-goal`
- `pi-web-access`（Web 検索・抽出・キュレーションツール: /websearch, /curator, /google-account, /search）
- `pi-hashline-edit-pro`
- `@gamaraan/todos-tool`（構造化 todo トラッキング: todo ツールがエディタ上部に計画チェックリストをライブ HUD 表示、/todo と /todos-configure コマンド付き）
- `pi-agent`（@giladbarnea/pi-user-agents からの同梱フォーク: 手動起動のバックグラウンドエージェント + ライブ進捗ウィジェット。`/agent -P/--plan` によるプランモードのバックグラウンド実行、ワンキー起動プリセット `/spawn` `/scout` `/blueprint` に対応。さらに `/dispatch` コマンドと `dispatch_agent` ツールによるエージェント主導のバッチ分散に対応)
- `pi-subagents`（単一エージェント委譲とスクリプト化されたマルチエージェントワークフロー: タスク委譲・バックグラウンド実行・オーケストレーション）
- `@ff-labs/pi-fff`（デスクトップ限定: フリークエンシー付き FFF ファイル検索。Android と Windows では除外）
- `@zzxb/pi-notify`（Windows 限定: ターミナルフォーカス・結果アイコン・BEL 通知に対応した Windows Toast 通知）

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

同梱の pi-web UI でブラウザチャット（provider とセッションは `axum code` と共有）:

```bash
axum chat
```

エージェントを起動します:

```bash
axum code
```

> ヒント: リポジトリのチェックアウト内では、`npm run` のラッパーを経由せずに `node bin/axum.js code`（またはグローバルの `code` コマンド）を実行すると、起動時間を約 0.2 秒短縮できます。

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

## ワンキー・バックグラウンドエージェント

3 つのプリセットコマンドが `/agent` のよく使うフラグ組み合わせを内蔵しており、バックグラウンド起動時のフラグ判断は不要です:

```text
/spawn fix the login bug        # = /agent -s fix the login bug
/scout why does the build fail  # = /agent -i why does the build fail
/blueprint add dark mode        # = /agent -P -s add dark mode
```

- `/spawn <タスク>` —— 現在の会話コンテキストを継承し、完了時に結果を自動でこの会話へ返します。
- `/scout <タスク>` —— 空白コンテキストで隔離起動し、セッションを継承しません。
- `/blueprint <タスク>` —— バックグラウンドでプランモードを実行し、完成したプランを自動で返します。

追加フラグも併用可能です（例: `/spawn -m gpt-5 …`）。プリセットは共通の `/agent` パーサ・ウィジェット・ライフサイクルへの接頭辞にすぎず、従来の `/agent [options] <タスク>` の挙動は変わりません。

## Doctor

```bash
axum doctor
```

`doctor` は bundled Pi cache と entrypoint を確認します。

セーフモード（`axum code --safe`）は、上記の同梱拡張を読み込まずに Pi 本体のみを起動します。


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
