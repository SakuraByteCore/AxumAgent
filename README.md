# Axum Agent

Axum Agent は、Pi ベースのコーディングエージェント配布パッケージです。Pi 本体と拡張を同梱して起動します。

同梱ランタイム:

- `@earendil-works/pi-coding-agent`
- `pi-subagents`
- `@cortexkit/pi-magic-context`
- `pi-rtk-optimizer`

> Android / Termux では `onnxruntime-node` が非対応のため、Magic Context は自動でスキップされます。pi-rtk-optimizer はネイティブ依存がないため Android / Termux でも読み込まれます。

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

## インストールメモ

`axum-agent` を npm に公開した後は、インストールコマンドは次の形になります:

```bash
npm install -g axum-agent
```

現時点では GitHub の source tarball URL を使うのが推奨です:

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

npm 10 で GitHub shorthand を使うと、環境によって global symlink が壊れることがあります。避けられない場合は `--install-links=true` を付けてください:

```bash
npm install -g --install-links=true github:SakuraByteCore/AxumAgent#main
```

## OpenAI 互換 provider の設定

`axum web` を実行し、Provider tab で保存します:

```bash
axum web
```

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


## System Prompt の編集

`axum web` の System Prompt tab で編集します。

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

通常のデスクトップ環境では、Axum は次の拡張 entrypoint を事前読み込みして Pi を起動します:

- `pi-subagents/index.ts`
- `@cortexkit/pi-magic-context/dist/index.js`
- `pi-rtk-optimizer/index.ts`

Android / Termux では Magic Context を読み込みません。pi-rtk-optimizer は全プラットフォームで読み込みます。

Magic Context の runtime data は上流拡張の仕様に従います。

## License

FSL-1.1-ALv2: Functional Source License, Version 1.1, ALv2 Future License. The future license grant is Apache License 2.0. See [LICENSE](./LICENSE).
