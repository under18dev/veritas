# はじめに

自分のプロジェクトに Veritas を入れ、環境を確かめて、パイプラインを一度実行するまでの手順です。バグを含む例で一通り試すなら、[チュートリアル](/ja/guide/tutorial)を参照してください。

## 必要なもの

| 項目                                 | 条件                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                              | 24 以上                                                                                                                                       |
| プロジェクトのコードを動かす Node.js | 25 以上（26 を推奨）。property-based testing と反例の再実行で、ネットワークを遮断して関数を動かすのに使います                                 |
| テストランナー                       | プロジェクトに入っている Vitest                                                                                                               |
| 言語                                 | TypeScript または JavaScript（ESM）                                                                                                           |
| OS                                   | Linux、macOS、Windows                                                                                                                         |
| 任意                                 | git（`--since` とコミット情報に使います）、`prove --engine lean` 用の Lean 4 と Lake（[elan](https://github.com/leanprover/elan) で入れます） |

Z3、`@mizchi/mutator`、fast-check はパッケージに含まれています。

property-based testing と反例の再実行には、Veritas を動かしている Node.js、`VERITAS_SANDBOX_NODE`、`PATH` 上の `node` の順に使います。どれも 25 未満の場合、これらの検査は行わず、結果は inconclusive になります。

## インストール

::: code-group

```bash [npm]
npm install -D @under18dev/veritas
```

```bash [pnpm]
pnpm add -D @under18dev/veritas
```

```bash [yarn]
yarn add -D @under18dev/veritas
```

```bash [bun]
bun add -d @under18dev/veritas
```

:::

パッケージには `veritas` と `veritas-mcp` の二つのコマンドが入っています。`npx veritas`、`pnpm exec veritas`、`yarn veritas`、`bunx veritas` のように、パッケージマネージャーから実行してください。このガイドでは多くの場合、短く `veritas` と書きます。

## 設定ファイルを作る

```bash
npx veritas init --yes
```

```text
wrote /path/to/project/.veritas/config.json
detected: package manager=npm, tsconfig=none, vitest=5.1.1, git=true
next:
  veritas doctor
  veritas discover --offline
  veritas run --profile quick --offline
```

| オプション  | 効果                                       |
| ----------- | ------------------------------------------ |
| `--yes`     | 検出した設定をそのまま使う                 |
| `--force`   | 既存の `.veritas/config.json` を上書きする |
| `--dry-run` | 書き出さずに設定を表示する                 |

プロジェクトが Vitest を使っていなければ、`init` は `VITEST_NOT_FOUND` で止まります。既定の設定では、ネットワーク上の出典と LLM はオフで、形式検証の整数の範囲は `[-10000, 10000]` です。すべての設定項目は[設定リファレンス](/ja/reference/configuration)にあります。

## 環境を確かめる

```bash
npx veritas doctor
```

```text
available   node             26.13.1 Node.js >= 24
available   git              git version 2.50.1 (Apple Git-155) git repository detected
available   package_manager  npm detected from lockfile
available   typescript       6.0.3 resolved from project
available   vitest           5.1.1 resolved from project
available   mutator          0.4.5 @mizchi/mutator resolved from project
available   fast_check       4.10.3 resolved from project
available   z3               5.4.1 z3-solver (wasm) resolved from project
[...]
disabled    llm               no LLM provider configured; rule-based analysis only
disabled    network           network access disabled (default)
available   sandbox           restricted process (permission model; defence in depth, the project's code is trusted): no writes, child processes or network

enabled   init
degraded  discover (missing: network, llm)
degraded  analyze (missing: llm)
enabled   mutate
[...]
enabled   prove (z3)
```

前半はツールごとの状態（`available`、`degraded`、`unavailable`、`disabled`）、後半はコマンドごとに使えるかどうかと、足りないものです。`network` と `llm` が足りずに `degraded` になるのは既定の状態で、どちらも任意の機能です。

## パイプラインを実行する

```bash
npx veritas run --profile standard
```

| プロファイル | 実行する内容                                                  | コードを動かすか         |
| ------------ | ------------------------------------------------------------- | ------------------------ |
| `quick`      | 出典の収集、コードとテストの解析、評価                        | 動かしません             |
| `standard`   | `quick` に mutation testing を加えたもの（既定）              | テストを動かします       |
| `deep`       | `standard` に property-based testing と Z3 の検査を加えたもの | テストと関数を動かします |

| オプション           | 効果                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--offline`          | Veritas はネットワークにアクセスしません（Web や GitHub の出典も LLM も使いません）。テストは `npm test` と同じように動きます |
| `--include-proposed` | accepted でない Property も検査します。結果は `suspected` のままです                                                          |
| `--since <ref>`      | mutation testing を、git の ref からの変更部分に絞ります                                                                      |

コマンドはステージ、verdict、finding を表示し、終了コードを返します。`0` は成功（警告付きを含む）、`1` は確定したポリシー違反、`2` は設定や使い方の誤り、`3` はツールのエラー、`4` は `fail` ポリシーで結論が出なかった場合です。出力の読み方は[結果の読み方](/ja/guide/reading-results)を参照してください。

## 結果を見る

実行ごとに `.veritas/runs/<run-id>/` ができます。`veritas report` で最新の結果をもう一度表示でき、`veritas explain <finding-id>` で一つの finding の根拠を確認できます。ファイルの内容は[レポートと成果物](/ja/reference/reports)にあります。

仕様についての決定は `.veritas/approvals.json` に記録されます。設定と決定はバージョン管理に入れ、それ以外は除外します。

```text
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

`.mutator/` は mutation testing のツールの作業ディレクトリです。

## 次に読むページ

- [チュートリアル](/ja/guide/tutorial)：小さなプロジェクトで境界のバグを見つけて直します。
- [仕様の確定](/ja/guide/specifications)：Veritas が見つけた規則を accept か reject します。
- [CI と GitHub Action](/ja/guide/ci)：プルリクエストで Veritas を実行します。
