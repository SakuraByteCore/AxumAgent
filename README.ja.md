# Axum Agent

Axum Agent は、Pi ベースのコーディングエージェント配布パッケージです。Pi 本体と拡張を同梱して起動します。

同梱ランタイム:

- `@earendil-works/pi-coding-agent`
- `pi-bar` (AxumAgent 同梱フォーク)
- `pi-header` (AxumAgent 同梱フォーク)
- `@narumitw/pi-goal`

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

拡張が壊れて起動できない場合は、bundled extensions を一切読み込まない安全モードで起動できます:

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
~/.pi/agent/SYSTEM.md
```

対象:

- Global `SYSTEM.md` — 既定。標準 prompt を置換
- Global `APPEND_SYSTEM.md` — 標準 prompt に追記
- Project `APPEND_SYSTEM.md` — `<cwd>/.pi/APPEND_SYSTEM.md`
- Project `SYSTEM.md` — `<cwd>/.pi/SYSTEM.md`

保存前に diff を表示します。ファイルが外部で変更されていた場合は保存を拒否します。

## Doctor

```bash
axum doctor
```

`doctor` は bundled Pi cache と entrypoint を確認します。
拡張の問題で通常起動できない場合は `axum code --safe` を使うと、Pi 本体だけを `-ne` で起動し、`pi-bar` / `pi-goal` / `pi-header` を読み込みません。

Bundled Pi ランタイムは npm の global package ディレクトリではなく、ユーザー cache に保存されます。そのため、Axum を再インストールしても通常は `axum code` の first-run setup を繰り返しません。

## 更新

```bash
axum update
```

GitHub の main ブランチの tarball で npm グローバルを再インストールします。通常は first-run setup の再実行不要です。

## License

FSL-1.1-ALv2: Functional Source License, Version 1.1, ALv2 Future License. The future license grant is Apache License 2.0. See [LICENSE](./LICENSE).

---

翻訳: [English](./README.md) | [中文](./README.zh-CN.md)
