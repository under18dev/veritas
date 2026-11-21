# トラブルシューティング

前半はよくあるエラーとその対処です。後半で、実行の中身を調べる方法を紹介します。

## よくある問題

| 症状                                                                         | 原因と対処                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEST_NOT_FOUND`                                                           | プロジェクトが Vitest を使っていません。Vitest を入れてください（`npm install -D vitest`）                                                                                                                                                                                                                                                                                                                                    |
| `CONFIG_MISSING`                                                             | `.veritas/config.json` がありません。`veritas init --yes` を実行し、CI 用にファイルをコミットしてください                                                                                                                                                                                                                                                                                                                     |
| `NO_RUN`                                                                     | `spec`、`report`、`explain`、`improve` は最新の実行を読みます。先に `veritas run` を実行してください                                                                                                                                                                                                                                                                                                                          |
| `doctor` で `mutate` が disabled                                             | Vitest が入っていません。プロジェクトの依存をインストールしてください。mutation テストには Vitest 4 以降と、`node_modules` へのインストール（Yarn Plug'n'Play ではないこと）も必要です                                                                                                                                                                                                                                        |
| mutation のステージが `failed`                                               | mutant がなくてもテストが失敗しています。先にテストを通してください。自分のテストコマンドでは通る場合は、メッセージの `first error` の行を確かめてください。Veritas に同梱の `@mizchi/mutator` は、プロジェクトの Vitest でテストを実行しますが、自分のファイルの一部を Veritas のインストール先から読み込みます。エラーにそのファイルが出ている場合は、`@mizchi/mutator` をプロジェクトの devDependencies に追加してください |
| `doctor` で `sandbox` が `unavailable`                                       | Node.js 25 未満では、プロジェクトのコードのネットワークアクセスを遮断できません。Node.js 25 以上を入れるか、`VERITAS_SANDBOX_NODE` で指定してください。`sandbox.allowNetworkWithoutIsolation` を設定すると遮断せずに実行します                                                                                                                                                                                                |
| `semantic_mismatch`                                                          | 整数モデルと JavaScript の結果が違います（安全な整数を超える値など）。`formal.integerDomain` を狭めるか、その関数はテストで確かめてください                                                                                                                                                                                                                                                                                   |
| 結果が `unsupported`                                                         | 関数が形式検証の対応範囲の外のコードを使っています。[対応環境](/ja/concepts/support-matrix)を参照してください                                                                                                                                                                                                                                                                                                                 |
| 結果が `timeout`                                                             | ソルバーが制限時間に達しました。`formal.maxSolverMs` を増やすか、`formal.integerDomain` を狭めてください                                                                                                                                                                                                                                                                                                                      |
| メモリ不足で `error`                                                         | `limits.memoryMb`（既定 2048 MiB）を増やしてください。プロジェクトのコード、テストランナー、mutator、Z3 に適用されます                                                                                                                                                                                                                                                                                                        |
| `doctor` で Lean が `unavailable`                                            | elan で Lean 4 を入れてください。`doctor` は `~/.elan/bin` も探します                                                                                                                                                                                                                                                                                                                                                         |
| `PROPERTY_NOT_FOUND` が出る、accepted にした Property が `proposed` に戻った | 記述のあるファイルが変わったため、Property の ID が変わりました。`veritas spec diff` で確かめ、新しい Property をレビューしてください                                                                                                                                                                                                                                                                                         |
| `APPROVAL_MISMATCH`                                                          | トークンがその計画のものでないか、計画が変わりました。`veritas improve --dry-run` をやり直し、新しいトークンを使ってください                                                                                                                                                                                                                                                                                                  |
| `IMPROVE_APPLY_IN_CI`                                                        | CI の中では `--apply` できません。手元で適用してください                                                                                                                                                                                                                                                                                                                                                                      |
| `IMPROVE_UNSAFE_LINK`                                                        | プロジェクトの外を指すシンボリックリンクがあります。実際のファイルやディレクトリに置き換えてください                                                                                                                                                                                                                                                                                                                          |
| ドキュメントの規則が `spec list` に出てこない                                | 規則で読めるのはしきい値の言い回しだけで、それ以外の記述は対応なしになります。[LLM プロバイダー](/ja/guide/llm-providers)を使うと、その一部を proposed な Property として読めます                                                                                                                                                                                                                                             |

## 実行の中身を調べる

| 手段                                 | 分かること                                                                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--debug` または `VERITAS_DEBUG=1`   | 標準エラー出力にデバッグのイベントが出ます。子プロセス（コマンド、引数、作業ディレクトリ、所要時間、終了コード、タイムアウトや強制終了）、プロジェクトのコードの制限つき呼び出し、ステージの開始と終了、キャッシュのヒットとミス |
| `--log-format json`                  | 標準エラー出力のログを、一行一つの JSON オブジェクトにします。標準出力は変わらないので、`--json` の出力は JSON だけのままです                                                                                                    |
| `.veritas/runs/<run-id>/trace.jsonl` | 同じイベントを、デバッグレベルも含めて実行ごとに記録します。上限は 4 MB で、最後の行に捨てたイベントの数が出ます                                                                                                                 |
| `veritas replay <run-id>`            | 以前の実行を、記録したステージとオプションでもう一度実行します                                                                                                                                                                   |
| `veritas report --run <run-id>`      | 指定した実行のレポート                                                                                                                                                                                                           |

ログとトレースには、環境変数の値もファイルの中身も含まれず、伏せ字の処理を通しています。

```bash
veritas --debug --log-format json run --profile standard 2> veritas-log.jsonl
```

`trace.jsonl` は一行が一つのイベントです。

```text
{"event":"stage","stage":"discover","at":"start","time":"2026-11-20T10:55:31.938Z","level":"debug","message":"stage discover started"}
```

`replay` は、どの実行を繰り返すかを表示してから実行します。

```text
replaying prove from run-20261120T105508829Z-000-017911 (prove --include-proposed)
```

ここにない問題は、`veritas doctor --json` の出力と `trace.jsonl` の関係する部分を添えて、[GitHub](https://github.com/under18dev/veritas/issues) に Issue を作成してください。
