# 信頼できないリポジトリ

Veritas のどのコマンドがプロジェクトのコードを実行するか、実行中にどんな制限がかかるか、信頼できないリポジトリをどう解析するかを説明します。リポジトリに Veritas を使うことは、そのリポジトリのテストを実行するのと同じリスクを伴います。

## 信頼のモデル

プロジェクトのコードは信頼されたコードとして扱います（[ADR 0011](/adr/0011-trusted-project-code)、英語）。次の操作でコードが実行されます。

| 操作                                   | 実行されるもの                                      |
| -------------------------------------- | --------------------------------------------------- |
| `run --profile standard`、`mutate`     | プロジェクトの Vitest のテスト。mutant ごとに一回   |
| `run --profile deep`                   | 加えて、property-based testing でプロジェクトの関数 |
| `prove`                                | 反例を実行し直すために、プロジェクトの関数          |
| `improve --apply`                      | 隔離したコピーの中で、プロジェクトのテスト          |
| `test generate` で作ったファイルの実行 | Vitest を通して、プロジェクトのコード               |

`run --profile quick`、`discover`、`analyze`、`spec`、`report`、`explain` は、プロジェクトのコードを実行しません。ただし `--allow-code-config` を付けると、`veritas.config.ts`、`veritas.config.mjs`、`veritas.config.js` を読み込んで実行します。

property-based testing と反例の再実行は、Node.js の permission model のもとで、別の Node.js プロセスで動かします。このプロセスはプロジェクトを読めるだけで、ファイルの書き込み、子プロセスやワーカーの起動、コードの生成はできず、Node.js 25 以上ならネットワークにもアクセスできません。mutation testing と `improve` は、許可した環境変数と空の一時ホームディレクトリでプロジェクトのテストランナーを動かしますが、ファイルの読み取りとネットワークは隔離しません。

これらの制限は事故を防ぐためのもので、悪意のあるコードに対するセキュリティの境界ではありません。Node.js の permission model 自体がそう説明されており、ネイティブアドオン、引き継いだファイルディスクリプタ、ランタイムのバグを通して回避できることが知られています。

信頼のモデルにかかわらず、次の点は変わりません。

- リポジトリ、Web、Issue、LLM の内容は信頼しないデータです。中に指示が書かれていても従いません。
- 書き込みには承認が要り、プロジェクトの中に限られます。
- ネットワークは既定でオフです。`--offline` は Veritas 自身のリクエストを止めますが、プロジェクトのテストは止めません。
- 子プロセスには、許可した環境変数だけを渡します。
- CI では、フォークのプルリクエストは秘密情報なしで動きます。

## 信頼できないリポジトリを解析する

Veritas 自体を、ネットワークのない隔離された環境で、リポジトリのコピーに対して動かします。Docker は Linux で使え、macOS と Windows では Docker Desktop で使えます。

```bash
# An image with Veritas, built without any project code.
printf 'FROM node:26\nRUN npm install -g @under18dev/veritas\n' | docker build -t veritas -
# Work on a fresh copy, so nothing the project's code does can change your checkout.
copy=$(mktemp -d) && cp -R untrusted-repo/. "$copy" && cd "$copy"
# Install the dependencies from the lockfile without running install scripts. Use the project's package
# manager: `pnpm install --frozen-lockfile --ignore-scripts`, `yarn install --immutable --mode=skip-build`
# (Yarn 2+) or `bun install --frozen-lockfile --ignore-scripts` instead of npm (enable them with corepack).
docker run --rm -v "$PWD":/work -w /work veritas npm ci --ignore-scripts
# Analyse with no network at all.
docker run --rm --network none -v "$PWD":/work -w /work veritas veritas init --yes
docker run --rm --network none -v "$PWD":/work -w /work veritas veritas run --offline --profile deep
```

補足です。

- ネットワークを使うのは依存のインストールだけで、そこでもインストールスクリプトは実行しません。依存はプロジェクトのパッケージマネージャーで、lockfile どおりに入れます（コメントにあるとおり、pnpm、Yarn 2 以降、bun のコマンドもあります。corepack で有効にしてください）。
- 解析は `--network none` で動かすので、Veritas もプロジェクトのテストもネットワークにアクセスできません。
- このイメージには Lean が入っていません。`prove --engine lean` を使うなら、イメージに elan を加えてください。
- 結果はコピーの `$copy/.veritas/runs/` で読むか、同じコンテナで `veritas report` や `veritas explain` を実行して確認します。

::: warning キャッシュの鍵
結果のキャッシュは、キャッシュディレクトリにある鍵（`~/.cache/veritas/cache-key`、または `VERITAS_CACHE_KEY_FILE`）で署名しています。コンテナの外で動かすと、プロジェクトのテストがこの鍵を読めてしまいます。信頼できないコードには、上のようにコンテナを使うか、`cache.enabled` を `false` にしてください。
:::

脅威モデルの全体は[セキュリティモデル](/ja/concepts/security)にあります。
