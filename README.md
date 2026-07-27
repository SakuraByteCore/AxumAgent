# Axum Agent

Axum Agent は、Pi ベースのコーディングエージェント配布パッケージです。Pi 本体と拡張を同梱して起動します。

同梱ランタイム:

- `@earendil-works/pi-coding-agent`
- `pi-subagents`
- `pi-hermes-memory`
- `@juanibiapina/pi-powerbar`
- `pi-edit` (AxumAgent 同梱フォーク)
- `@narumitw/pi-goal`
- `@juicesharp/rpiv-todo`

> Android / Termux 環境では、`pi-hermes-memory` と `pi-edit` は Node.js 組み込みの `node:sqlite` + `node:crypto` を使用し、ネイティブコンパイル不要で動作します。pi-powerbar、pi-goal、rpiv-todo もネイティブ依存がないため全プラットフォームで読み込まれます。

## クイックスタート

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

```bash
axum
```

Provider と System Prompt を Web で設定します:

```bash
axum web
```

起動します:

```bash
axum code
```

Pi の引数も渡せます:

```bash
axum code --print "inspect this repository"
axum code --help
```

状態確認:

```bash
axum doctor
```

## OpenAI 互換 provider の設定

「クイックスタート」の `axum web` から Provider tab で保存します。

入力項目:

- Base URL。例: `https://api.moonshot.cn/v1`
- API Key
- Model。`/models` がない provider は手入力できます

保存先:

- `~/.pi/agent/models.json`
- `~/.pi/agent/axum.json`

保存後:

```bash
axum code
```

互換性のため、OpenAI 互換 provider は `supportsDeveloperRole=false` / `supportsReasoningEffort=false` を既定にします。


## リトライ設定

`axum web` のリトライ tab で、API リクエスト失敗時の自動リトライ戦略を設定します（起動方法は「クイックスタート」参照）。

設定項目:

- リトライ有効化 — 既定は無効。Pi 本体の既定は有効だが、Axum は明示的な有効化を要求する
- 最大リトライ回数 — 既定 3
- 基底バックオフ遅延 (ms) — 既定 2000。指数バックオフ: `baseDelayMs * 2^(attempt-1)`

リトライ対象は過負荷・レート制限・サーバーエラー。コンテキスト超過はリトライ対象外（圧縮で処理）。

保存先:

- `~/.pi/agent/settings.json`

## System Prompt の編集

`axum web` の System Prompt tab で編集します（起動方法は「クイックスタート」参照）。

既定:

```text
~/.pi/agent/APPEND_SYSTEM.md
```

対象:

- Global `APPEND_SYSTEM.md` — 既定。標準 prompt に追記
- Global `SYSTEM.md` — 標準 prompt を置換
- Project `APPEND_SYSTEM.md` — `<cwd>/.pi/APPEND_SYSTEM.md`
- Project `SYSTEM.md` — `<cwd>/.pi/SYSTEM.md`

保存前に diff を表示します。ファイルが外部で変更されていた場合は保存を拒否します。

## Doctor

```bash
axum doctor
```

`doctor` は bundled Pi cache と entrypoint を確認します。

Bundled Pi ランタイムは npm の global package ディレクトリではなく、ユーザー cache に保存されます。そのため、Axum を再インストールしても通常は `axum code` の first-run setup を繰り返しません。

## 拡張の動作

通常のデスクトップ環境および Android / Termux 環境では、Axum は次の拡張 entrypoint を事前読み込みして Pi を起動します:

- `pi-subagents/index.ts`
- `pi-hermes-memory/src/index.ts`
- `@juanibiapina/pi-powerbar/src/powerbar/index.ts` (core)
- `@juanibiapina/pi-powerbar/src/powerbar-context/index.ts`
- `@juanibiapina/pi-powerbar/src/powerbar-git/index.ts`
- `@juanibiapina/pi-powerbar/src/powerbar-model/index.ts`
- `@juanibiapina/pi-powerbar/src/powerbar-provider/index.ts`
- `@juanibiapina/pi-powerbar/src/powerbar-sub/index.ts`
- `@juanibiapina/pi-powerbar/src/powerbar-tokens/index.ts`
- `@juanibiapina/pi-powerbar/node_modules/@juanibiapina/pi-usage/index.ts`
- `pi-edit/index.ts`
- `@narumitw/pi-goal/src/index.ts`
- `@juicesharp/rpiv-todo/index.ts`

全拡張はネイティブ依存がないため全プラットフォームで読み込みます。各拡張の機能:

- **pi-subagents** — サブエージェントの spawn・管理
- **pi-hermes-memory** — Hermes 型の永続メモリとラーニングループ
- **pi-powerbar** — powerline 型ステータスバー (git・model・token・provider 表示)
- **pi-edit** — ハッシュアンカー付 `read`/`replace` ツール、`/toggle-replace-mode`・`/toggle-auto-read` コマンド
- **pi-goal** — `/goal` コマンドで自律タスク完了を管理
- **rpiv-todo** — `todo` ツール、`/todos` コマンド、`/reload` と会話圧縮を跨ぐ永続オーバーレイ

Android / Termux の詳細は冒頭の注釈を参照してください。

## License

FSL-1.1-ALv2: Functional Source License, Version 1.1, ALv2 Future License. The future license grant is Apache License 2.0. See [LICENSE](./LICENSE).
