# トラブルシューティング

## 実行をデバッグする

| 手段                                  | 分かること                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--debug`（または `VERITAS_DEBUG=1`） | 標準エラー出力にデバッグのイベントが出ます。起動した子プロセス（コマンド、引数、作業ディレクトリ、所要時間、終了コード、タイムアウトや強制終了）、プロジェクトのコードの制限つき呼び出し、ステージの開始と終了、キャッシュのヒットとミス |
| `--log-format json`                   | 標準エラー出力のログを、一行に一つの JSON オブジェクトで出します（`time`、`level`、`message` と、`event`、`stage`、`durationMs` などの項目）。標準出力は変わらないので、`--json` の出力は JSON だけのままです                            |
| `.veritas/runs/<run-id>/trace.jsonl`  | 実行ごとに、デバッグレベルを含む同じイベントを記録します。上限は 4 MB で、最後の行に捨てたイベントの数が出ます                                                                                                                           |
| `veritas replay <run-id>`             | 記録したステージとオプションで、その実行をやり直します                                                                                                                                                                                   |
| `veritas report --run <run-id>`       | 指定した実行のレポートを表示します                                                                                                                                                                                                       |

ログとトレースには、環境変数の値もファイルの中身も含まれず、すべて伏せ字の処理を通しています。

```bash
veritas --debug --log-format json run --profile standard 2> veritas-log.jsonl
```

`trace.jsonl` の一行です。

```json
{
  "event": "stage",
  "stage": "index",
  "at": "end",
  "status": "succeeded",
  "durationMs": 4,
  "time": "2026-11-20T10:10:38.818Z",
  "level": "debug",
  "message": "stage index succeeded in 4 ms"
}
```

`replay` は、どの実行をやり直すかを表示してから実行します。

```text
replaying prove from run-20261120T104653570Z-000-cd8b2a (prove --include-proposed)
```

## よくある問題

| 症状                                                                         | 原因と対処                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEST_NOT_FOUND`                                                           | プロジェクトに Vitest を入れてください（`pnpm add -D vitest`）                                                                                                                                                                         |
| `CONFIG_MISSING`                                                             | `veritas init --yes` を実行するか、CI で使えるよう `.veritas/config.json` をコミットしてください                                                                                                                                       |
| `NO_RUN`                                                                     | `spec`、`report`、`explain`、`improve` は最新の実行を読みます。先に `veritas run` を実行してください                                                                                                                                   |
| `doctor` で `mutate` が disabled                                             | プロジェクトに Vitest が入っていません。Vitest を入れるか、プロジェクトの依存をインストールしてください                                                                                                                                |
| mutation のステージが `failed`                                               | プロジェクトのテスト自体が失敗しています。まずそれを直してください                                                                                                                                                                     |
| `semantic_mismatch`                                                          | 整数モデルと JavaScript の結果が食い違っています（安全な整数を超える桁あふれなど）。`formal.integerDomain` を狭めるか、テストで確かめてください                                                                                        |
| 結果が `unsupported`                                                         | 関数が形式検証の対応範囲の外の構文を使っています。[対応環境](/ja/concepts/support-matrix)を参照してください                                                                                                                            |
| 結果が `timeout`                                                             | ソルバーの時間が足りません。`formal.maxSolverMs` を増やすか、`formal.integerDomain` を狭めてください                                                                                                                                   |
| Lean が `unavailable`                                                        | elan で Lean を入れてください。`doctor` は `~/.elan/bin` も探します                                                                                                                                                                    |
| `sandbox` が `unavailable`                                                   | Node.js 25 未満では、プロジェクトのコードのネットワークアクセスを遮断できません。Node.js 25 以上を入れるか、`VERITAS_SANDBOX_NODE` でそれを指定してください（`sandbox.allowNetworkWithoutIsolation` を設定すると遮断なしで実行します） |
| メモリ不足で `error`                                                         | `limits.memoryMb`（既定 2048 MiB）を増やしてください。プロジェクトのコード、テストランナー、mutator、Z3 のプロセスに効きます                                                                                                           |
| `PROPERTY_NOT_FOUND` が出る、accepted にした Property が `proposed` に戻った | Property の ID は、文とその出典の内容から決まります。文が変わると別の Property になるので、`veritas spec diff` で確かめて、もう一度レビューしてください                                                                                |
| `IMPROVE_APPLY_IN_CI`                                                        | CI の中での改善の適用は、意図して拒否しています。手元で適用してください                                                                                                                                                                |
| `APPROVAL_MISMATCH`                                                          | トークンがこの計画のものでないか、計画が変わっています。`veritas improve --dry-run` をもう一度実行し、新しいトークンを使ってください                                                                                                   |
| `IMPROVE_UNSAFE_LINK`                                                        | プロジェクトの外を指すシンボリックリンクがあります。適用する前に、実際のファイルやディレクトリに置き換えてください                                                                                                                     |
| ドキュメントの記述が見つからない                                             | 規則による抽出が読むのは、しきい値の言い回しです。それ以外の記述は対応なしのままになります。[LLM プロバイダー](/ja/guide/llm-providers)を設定すると、その一部を proposed な Property として読めます                                    |

ここにない問題は、`veritas doctor --json` の出力と `trace.jsonl` の関係する部分を添えて Issue を作成してください。
