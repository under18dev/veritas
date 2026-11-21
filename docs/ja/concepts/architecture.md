# アーキテクチャ

Veritas は、テストごとに次の問いに答えます。どの仕様から導かれたテストか、何を観測しているか、どの欠陥を検出するか、どのモデルと範囲のもとで何を形式的に確かめたか、何がまだ分かっていないか。それぞれの答えの根拠は、機械可読なファイルに書き出します。以下では、1 回の実行が Veritas のパッケージをどう流れるかを追い、データの保存場所も示します。結果の意味は[セマンティクス](/ja/concepts/semantics)を参照してください。

## パイプライン

```text
CLI / Node API / Agent Skill / MCP / GitHub Action
                       |
               Orchestrator (engine)
                       |
    +------------------+-------------------+
Evidence collectors  Code intelligence  Test inventory
    +---------- Specification engine ------+
                        |
                 Property registry
       +----------------+------------------+
 Mutation adapter  Property-based tests  Formal adapter
   (mutator)          (fast-check)        (Z3 / Lean)
       +----------------+------------------+
                 Assessment engine
                        |
               Improvement planner
                        |
        Artifact store / reporters / CI policy
```

## パッケージ

| パッケージ                 | 役割                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                     | ドメインのスキーマ、Property IR、成果物の保存、キャッシュ、ID、ポリシー、終了コード、プロセスの実行、パスの安全性、秘密情報の秘匿、プロジェクトの検出、`init`/`doctor`                                   |
| `cli`                      | `veritas` と `veritas-mcp` の実行ファイル。`@under18dev/veritas` として公開。引数を解析し、各パッケージの API を呼び出す                                                                                 |
| `engine`                   | オーケストレーターと Node API。ステージの実行、実行の成果物の保存、レポート、`explain`、仕様の操作。CLI、MCP サーバー、GitHub Action が共有する                                                          |
| `spec-discovery`           | 根拠の収集（ローカル、GitHub、Web）、出典の関係、規範的な文の抽出                                                                                                                                        |
| `code-intelligence`        | TypeScript の解析。export、シグネチャ、分岐、境界、副作用                                                                                                                                                |
| `property-engine`          | Property の登録、レビューの状態遷移、食い違い、承認                                                                                                                                                      |
| `test-inventory`           | テストの検出、assertion の解析、テスト・シンボル・Property のグラフ。テスト API の名前はプロジェクトのテストランナーのものを使う                                                                         |
| `mutation-adapter`         | mutation のバックエンドを実行し、結果を正規化する                                                                                                                                                        |
| `property-testing`         | fast-check のジェネレーター、seed、shrink、再実行                                                                                                                                                        |
| `formal-core`              | TypeScript の部分集合から Property IR への変換、主張、意味の検証                                                                                                                                         |
| `solver-z3`、`solver-lean` | ソルバーのバックエンド                                                                                                                                                                                   |
| `assessment`               | 証拠のベクトルとテストの判定                                                                                                                                                                             |
| `improvement`              | 計画、隔離したワークスペースでの承認済みパッチの適用、ロールバック                                                                                                                                       |
| `llm`、`llm-providers/*`   | プロバイダーに依存しない LLM のインターフェースと、プロバイダーごとのアダプター。`llm-providers/claude`（Anthropic API）、`claude-code`（Claude Code CLI）、`openai`（OpenAI API）、`codex`（Codex CLI） |
| `test-runners/*`           | テストランナーごとの provider。`core` の `TestRunnerProvider` インターフェースを実装する。検出、テスト API の名前、テストの実行、mutation とのつなぎ、生成するテストの書き方。今は `vitest` のみ         |
| `reports`                  | テキスト、JSON、Markdown、HTML、SARIF                                                                                                                                                                    |
| `mcp`                      | MCP サーバー                                                                                                                                                                                             |
| `github-action`            | CI との連携                                                                                                                                                                                              |

各部分が何に対応しているかは[対応環境](/ja/concepts/support-matrix)にまとめています。

## 各部分の関係

- CLI、Node API、MCP サーバー、GitHub Action は、同じパッケージの関数を呼び出します。コマンドと、それに対応する API の関数や MCP のツールは、同じステージを実行して同じファイルを書きます。たとえば `veritas analyze`、`analyze()`、MCP のツール `analyze_tests` がそうです。
- ステージは、それぞれ自分の結果だけを報告します。例外を投げたステージは `error` になり、失敗したステージに依存するステージは `skipped` になります。あるステージが、別のステージの代わりに成功を報告することはありません。

## 保存場所

| パス                                                                                  | 内容                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `.veritas/config.json`（`--allow-code-config` 付きなら `veritas.config.{ts,mjs,js}`） | 設定                                                                                                                |
| `.veritas/approvals.json`                                                             | Property についての人の判断。誰が、いつ、何を、なぜ                                                                 |
| `.veritas/runs/<run-id>/`                                                             | 実行ごとの成果物。根拠、Property、テストの対応、mutant、ソルバーの入出力、パッチ、レポート                          |
| `.veritas/cache/`                                                                     | 結論の出たソルバーの結果、LLM の応答、mutation の実行を内容ごとに保存するキャッシュ。git で管理されていれば無視する |
| `.veritas/improvements/<plan-id>/`                                                    | 改善計画、承認、適用の記録                                                                                          |
| `.veritas/generated-tests/`                                                           | `veritas test generate` が書き出した property-based テストのファイル                                                |

JSON の成果物は、どれも `schemaVersion`、`runId`、`createdAt`、`toolVersion`、`gitCommit`、`configHash`、`sourceHash` を持つエンベロープです（[ADR 0002](/adr/0002-schemas-and-artifacts)、英語）。エンベロープを持てないファイル（ソルバーの入出力、Lean のソース、描画したレポート、mutator 自身のレポートのファイル）は、SHA-256 付きで `artifact-index.json` に載り、そのインデックスがメタデータを持ちます。描画したレポートにもメタデータを表示します。JSON Schema は `schemas/` にあります。実行で作られるファイルの一覧は[レポートと成果物](/ja/reference/reports)を参照してください。

## 終了コード

| コード | 意味                                                               |
| ------ | ------------------------------------------------------------------ |
| 0      | 成功                                                               |
| 1      | ポリシー違反が確定した                                             |
| 2      | 設定が不正、またはユーザーのエラー                                 |
| 3      | ツールまたは実行環境のエラー（このビルドで使えないコマンドを含む） |
| 4      | 設定したポリシーのもとで判定できなかった                           |

`--json` を付けると stdout には JSON だけを出し、ログは stderr に出します。verdict については [CLI リファレンス](/ja/reference/cli#終了コード)を参照してください。
