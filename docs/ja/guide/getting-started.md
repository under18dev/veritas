# はじめに

既存のプロジェクトに Veritas を入れ、環境を確かめて、パイプラインを一度実行するまでの手順です。

## 必要なもの

| 項目                                 | 条件                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                              | Veritas の実行には 24 以上                                                                                                                                                                                      |
| プロジェクトのコードを動かす Node.js | 25 以上（26 を推奨）。property-based testing と反例の再実行は、ネットワークを遮断できる Node.js でだけプロジェクトの関数を呼びます。実行中の Node.js、`VERITAS_SANDBOX_NODE`、`PATH` 上の `node` の順に使います |
| テストランナー                       | プロジェクトに入っている Vitest                                                                                                                                                                                 |
| 言語                                 | TypeScript または JavaScript（ESM）                                                                                                                                                                             |
| OS                                   | Linux、macOS、Windows                                                                                                                                                                                           |
| 任意                                 | git（`--since` とコミット情報に使います）、`prove --engine lean` 用の Lean 4 と Lake（[elan](https://github.com/leanprover/elan) で入れます）                                                                   |

Z3（`z3-solver` の WebAssembly 版）、`@mizchi/mutator`、fast-check はパッケージの依存に含まれているので、別に入れる必要はありません。

Node.js 24 でも Veritas は動きますが、property-based testing と反例の再実行は行われず、関係する結果は inconclusive のままになります。

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

パッケージには `veritas` と `veritas-mcp` の二つのコマンドが入っています。`npx veritas`、`pnpm exec veritas`、`yarn veritas`、`bunx veritas` のように実行してください。このガイドの例では、短く `veritas` と書きます。

```bash
npx veritas --version
```

## 設定ファイルを作る

```bash
npx veritas init --yes
```

```text
wrote /path/to/project/.veritas/config.json
detected: package manager=unknown, tsconfig=none, vitest=5.1.1, git=true
next:
  veritas doctor
  veritas discover --offline
  veritas run --profile quick --offline
```

`init` はパッケージマネージャー、`tsconfig.json`、Vitest、git を調べ、`.veritas/config.json` を書き出します。ファイルがすでにあると、`--force` を付けない限り上書きしません。`--dry-run` を付けると、書き出さずに設定を表示します。プロジェクトが Vitest を使っていなければ、`VITEST_NOT_FOUND` で止まります。

既定の設定では、ネットワーク上の出典と LLM はオフ、形式検証の整数の範囲は `[-10000, 10000]` です。すべての設定項目は[設定リファレンス](/ja/reference/configuration)にあります。

## 環境を確かめる

```bash
npx veritas doctor
```

`doctor` は、ツールごとに `available`、`degraded`、`unavailable`、`disabled` のどれかを示し、続けて機能ごとに使えるかどうかと、足りないものを示します。出力の一部です。

```text
available   node             26.13.1 Node.js >= 24
available   vitest           5.1.1 resolved from project
available   mutator          0.4.5 @mizchi/mutator resolved from project
disabled    llm               no LLM provider configured; rule-based analysis only
disabled    network           network access disabled (default)
available   sandbox           restricted process (permission model; defence in depth, the project's code is trusted): no writes, child processes or network

enabled   init
degraded  discover (missing: network, llm)
enabled   mutate
```

`network` と `llm` が足りずに `degraded` になるのは、ふつうの状態です。どちらも任意の機能で、既定でオフになっています。

## パイプラインを実行する

```bash
npx veritas run --profile standard
```

| プロファイル | 実行するステージ                                              | プロジェクトのコードを動かすか   |
| ------------ | ------------------------------------------------------------- | -------------------------------- |
| `quick`      | 出典の収集、コードとテストの解析、評価                        | 動かしません                     |
| `standard`   | `quick` に mutation testing を加えたもの（既定）              | プロジェクトのテストを動かします |
| `deep`       | `standard` に property-based testing と Z3 の検査を加えたもの | テストと関数を動かします         |

よく使うオプションです。

- `--offline`：Veritas 自身はネットワークにアクセスしません（Web や GitHub の出典も LLM も使いません）。プロジェクトのテストは、`pnpm test` と同じように動きます。
- `--include-proposed`：まだ誰も accepted にしていない Property も検査します。結果は `suspected` のままです。
- `--since <ref>`：mutation testing を、git の ref からの変更部分に絞ります。

コマンドはステージ、verdict、finding を表示し、終了コードを返します。`0` は成功（警告付きを含む）、`1` は確定したポリシー違反、`2` は設定や使い方の誤り、`3` はツールのエラー、`4` は `fail` ポリシーのもとで結論が出なかった場合です。詳しくは[結果の読み方](/ja/guide/reading-results)を参照してください。

## 結果の保存先

実行するたびに `.veritas/runs/<run-id>/` ができます。

| ファイル                             | 中身                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `run.json`                           | コマンド、オプション、ステージ、verdict、終了コード                                 |
| `evidence.json`                      | 集めた出典と、その出どころ                                                          |
| `properties.json`                    | Property とレビューの状態                                                           |
| `test-map.json`、`assessments.json`  | テスト、Property との結び付き、evidence vector                                      |
| `mutation.json`                      | mutant とその状態                                                                   |
| `pbt.json`、`claims.json`、`proofs/` | property-based testing、形式検証の結果、SMT と Lean のファイル（`deep` と `prove`） |
| `findings.json`                      | finding                                                                             |
| `report.{json,md,html,sarif}`        | レポート                                                                            |
| `trace.jsonl`                        | デバッグ用のイベントの記録                                                          |

`veritas report` は最新の実行結果をもう一度表示し、`veritas explain <finding-id>` は一つの finding の根拠をたどって表示します。

仕様についての決定は `.veritas/approvals.json` に記録されます。設定と決定はリポジトリに入れ、実行結果とキャッシュは入れない `.gitignore` の例です。

```text
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

`.mutator/` は mutation testing のツールが使う作業ディレクトリです。

## 次に読むページ

- [チュートリアル](/ja/guide/tutorial)：境界のバグがある小さなプロジェクトで、最初から最後まで試します。
- [結果の読み方](/ja/guide/reading-results)：verdict、finding、テストの判定、各種の状態。
- [仕様の確定](/ja/guide/specifications)：ドキュメントから見つかった仕様をレビューし、accepted にします。
- [CI と GitHub Action](/ja/guide/ci)：プルリクエストで Veritas を実行します。
