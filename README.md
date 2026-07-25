# Axum Agent

Axum Agent は、Pi ベースのコーディングエージェント配布パッケージです。Pi 本体と拡張スタックを Axum 側でまとめて起動するため、ユーザーが subagents や Magic Context を個別に `pi install` する必要はありません。

同梱ランタイム:

- `@earendil-works/pi-coding-agent`
- `pi-subagents`
- `@cortexkit/pi-magic-context`

> Android / Termux では `@cortexkit/pi-magic-context` の依存である `onnxruntime-node` が Android をサポートしていないため、Axum は Magic Context を自動的にスキップし、Pi CLI と `pi-subagents` のみをインストール・読み込みます。

## クイックスタート

現在の GitHub `main` ブランチの tarball からインストールします:

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

Axum のコマンド一覧を表示します:

```bash
axum
```

一時的なローカル Web ページで OpenAI 互換 provider を設定します。コマンド実行後、Axum は既定のブラウザで設定ページを自動的に開きます:

```bash
axum provider web
```

provider 設定を保存したあと、同梱 Pi コーディングエージェントを起動します:

```bash
axum code
```

`code` の後ろに Pi の引数を渡せます:

```bash
axum code --print "inspect this repository"
axum code --help
```

同梱 Pi ランタイムと拡張の状態を確認します:

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

一番簡単な方法は、一時的なローカル Web 設定ページを使うことです。`axum provider web` はローカルサーバーを起動し、既定のブラウザで設定ページを自動的に開きます:

```bash
axum provider web
```

ブラウザで開いたページに、次の項目を入力します。自動で開けない環境では、ターミナルに表示されたローカル URL を手動で開いてください:

- Base URL。例: `https://api.moonshot.cn/v1`
- API Key
- 取得した model 一覧から選んだ Model。provider が `/models` を公開していない場合は手入力できます

このページは Pi の `~/.pi/agent/models.json` と、Axum のデフォルト provider/model 選択を保存します。保存後にコピー用コマンドは表示しません。ページを閉じて、次を実行してください:

```bash
axum code
```

OpenAI 互換サーバーでは、Axum は互換性を優先して `supportsDeveloperRole=false` と `supportsReasoningEffort=false` をデフォルトにします。

## Doctor

```bash
axum doctor
```

`doctor` は、同梱 Pi CLI と同梱拡張の entrypoint が存在するかを確認し、Axum が使っている bundled Pi cache の場所も表示します。

Bundled Pi ランタイムは npm の global package ディレクトリではなく、ユーザー cache に保存されます。そのため、Axum を再インストールしても通常は `axum code` の first-run setup を繰り返しません。

## 拡張の動作

通常のデスクトップ環境では、Axum は次の拡張 entrypoint を事前読み込みして Pi を起動します:

- `pi-subagents/index.ts`
- `@cortexkit/pi-magic-context/dist/index.js`

これにより、Axum をインストールするだけで必要なパッケージが揃った状態になります。`pi install npm:pi-subagents` や `pi install npm:@cortexkit/pi-magic-context` を別途実行する必要はありません。

Android / Termux では Magic Context を読み込みません。これは `onnxruntime-node` が Android をサポートしていないためです。Termux でも `axum code` が起動できるように、Axum は対応している拡張だけを選んでインストール・起動します。

Magic Context は、上流拡張の仕様に従って独自のランタイムデータや設定を作成・利用する場合があります。Axum はユーザーのホームディレクトリやマシン固有のパスをハードコードしません。
