# レポートと成果物

CLI、Node API、MCP サーバー、GitHub Action のどれから実行しても、同じファイルができます。このリファレンスには、レポートの形式と節、`.veritas/runs/<run-id>/` にできるファイル、各ファイルが持つメタデータ、秘密情報の扱いを載せています。レポートの読み取り方は[結果の読み方](/ja/guide/reading-results)を参照してください。

## レポートの形式

```bash
veritas report                          # 最新の実行のテキストの要約
veritas report --format html > report.html
veritas report --format sarif --run <run-id> > veritas.sarif
veritas report --json                   # --format json と同じ
```

| 形式     | `--format` | 実行ディレクトリのファイル | 用途                                                   |
| -------- | ---------- | -------------------------- | ------------------------------------------------------ |
| テキスト | `text`     | なし（表示のみ）           | 端末での要約。`veritas report` の既定                  |
| JSON     | `json`     | `report.json`              | ほかの形式で表示する内容のすべて。ツールから読む用途   |
| Markdown | `markdown` | `report.md`                | プルリクエストのコメントや文書                         |
| HTML     | `html`     | `report.html`              | ブラウザーで読むための、1 ファイルで完結したページ     |
| SARIF    | `sarif`    | `report.sarif`             | コードスキャンのツール向けの SARIF 2.1.0。位置情報付き |

ファイルを書き出すのは report ステージを含むコマンド（どのプロファイルの `veritas run` も、`veritas prove` も含む）で、形式は `reports.formats` に従います（既定は `json`、`markdown`、`html`、`sarif`。`text` はファイルには書きません）。`veritas report` は、最新の実行または `--run <run-id>` で指定した実行から、どの形式でもその場で描画し、表示する内容の秘密情報を伏せます。

## レポートの節

JSON、Markdown、HTML のレポートには、同じ 10 の節があります。節の見出しは英語のままです。

| 節                                            | 内容                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1. Run metadata/environment/scope             | 実行の ID、コマンド、プロファイル、オプション、各ステージの状態とメッセージ、verdict と理由、エンベロープのメタデータ |
| 2. Collected evidence with provenance         | 出典（場所、種類、信頼度）と、そこから引用した規範的な文                                                              |
| 3. Property ledger                            | すべての Property と、そのレビューの状態、由来、出典、形式モデル                                                      |
| 4. Specification vs implementation mismatches | コードと Property が食い違う finding と、その反例                                                                     |
| 5. Tests x properties matrix                  | どのテストがどの Property に関係するか                                                                                |
| 6. Mutation outcomes                          | 状態ごとの mutant と、それを通るテスト・kill したテスト                                                               |
| 7. Formal claims                              | 各主張の種類、状態、エンジン、保証の種類、範囲、前提、反例                                                            |
| 8. Test assessments                           | 各テストの証拠のベクトルと判定                                                                                        |
| 9. Improvement proposals                      | その実行から作った改善計画と、その適用の記録                                                                          |
| 10. Limitations                               | その実行で確かめられなかったことと、その理由                                                                          |

Markdown のレポートでは、プロジェクトが大きいほど長くなる二つの節を要約します。「2. Collected evidence with provenance」には、出典の種類ごとに出典と文の数を示し、文の多い出典を種類ごとに三つ、それぞれの引用を二つ添えます。「3. Property ledger」には、推定（inferred）でない Property をすべて載せ、推定の Property は最初の五つだけを詳しく示して、残りは数だけを示します。JSON と HTML のレポート、実行の `evidence.json` と `properties.json` には、すべての項目が残ります。どの形式でも「10. Limitations」では、推定の Property を一つずつ挙げず、その数を一行で示します。Property ledger では、そのそれぞれに推定であることを示しています。

ステージを実行しなかった節は空になります。一方、ファイルがあるのに読めない成果物は、空の節ではなくエラーとして扱います。壊れたファイルのせいで finding が隠れないようにするためです。

`report.json` のトップレベルには、`schemaVersion` と `meta`（後述のエンベロープのメタデータ）があり、続いて `run`、`sources`、`statements`、`properties`、`conflicts`、`tests`、`edges`、`assessments`、`mutants`、`claims`、`findings`、`improvements`、`artifactBase` が並びます。

## 実行ディレクトリ

`veritas run --profile deep` を実行すると、次の構成になります。ほかのコマンドでは、実行したステージが作るファイルだけができます。

```text
.veritas/runs/run-20261120T100639627Z-000-a465b9/
├── run.json              command, options, scope, stages, verdict, policy reasons
├── code-index.json       exported functions, signatures, branches (index stage)
├── evidence.json         sources and quoted statements (discover stage)
├── properties.json       properties, conflicts, statement mapping, formalization (spec stage)
├── test-map.json         tests, assertions, test-property edges (map stage)
├── mutation.json         mutants and their status (mutate stage)
├── mutation/             mutator's own report and the Vitest configuration it ran with
├── pbt.json              property-based test results with seeds (pbt stage)
├── pbt/                  one file per property-based test (PBT-<id>.json)
├── claims.json           formal claims (prove stage)
├── proofs/               solver inputs and outputs, JavaScript replays
├── assessments.json      test assessments (assess stage)
├── findings.json         findings
├── report.json  report.md  report.html  report.sarif
├── artifact-index.json   SHA-256 and metadata of every file without an envelope
└── trace.jsonl           every log event of the run, debug level included
```

mutation の結果をキャッシュから再利用したときは、`mutation/` ディレクトリはできません。

| ファイル              | 内容                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.json`            | ID、コマンド、引数、プロファイル、範囲、オプション、開始と終了の時刻、各ステージの状態・メッセージ・成果物・使用量、終了コード、verdict、ポリシーの理由                                                                                    |
| `code-index.json`     | プロジェクトのソースのコード索引                                                                                                                                                                                                           |
| `evidence.json`       | 集めた出典とその由来・信頼度、文、収集を省略した出典                                                                                                                                                                                       |
| `properties.json`     | `properties`、`conflicts`、`mapping`（各文がどうなったか）、`formalization`、`staleApprovals`                                                                                                                                              |
| `test-map.json`       | テストの一覧と、テスト・シンボル・Property のあいだの関係                                                                                                                                                                                  |
| `mutation.json`       | mutation の件数と mutant。各 mutant には、それを通るテスト（`coveredBy`）と kill したテスト（`killedBy`）が付きます                                                                                                                        |
| `pbt.json`            | 各 property-based テストの状態、seed、実行回数、反例、shrink の経路、再実行のコマンド                                                                                                                                                      |
| `claims.json`         | 形式的な主張。種類、状態、エンジンとそのバージョン、保証の種類、前提、範囲、意味のずれ、ソルバーの入出力のファイル、反例と JavaScript での再現                                                                                             |
| `proofs/`             | Z3 では `<claim-id>.smt2`（クエリ）、`<claim-id>.out`（ソルバーの出力）、`<claim-id>.replay.json`（JavaScript での再生）。主張によっては範囲や境界の確認も加わります。Lean では `proofs/lean/<claim-id>/` に Lake のプロジェクトを置きます |
| `assessments.json`    | テストごとの評価。証拠のベクトル、判定、不明な点                                                                                                                                                                                           |
| `findings.json`       | finding の種類、題名、重大度、certainty、位置、根拠になった Property と出典                                                                                                                                                                |
| `artifact-index.json` | エンベロープを持てないファイルの、パス、種類、SHA-256、サイズ、作成日時                                                                                                                                                                    |
| `trace.jsonl`         | ログのイベントを 1 行に 1 つの JSON で記録します（`time`、`level`、`message` と、`event`、`stage` などのフィールド）。上限は 4 MB で、最後の行に捨てたイベントの数を書きます                                                               |

Veritas は、終わった実行のうち新しいものを `storage.retainRuns` 個（既定は 20）残し、実行が終わるたびにそれより古いものを削除します。実行中のものは削除しません。

`.veritas/` にはほかに次のファイルがあります。

| パス                               | 内容                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `.veritas/config.json`             | 設定（[設定](/ja/reference/configuration)を参照）                                               |
| `.veritas/approvals.json`          | Property についての判断を追記していく記録。誰が、いつ、何を、なぜ判断したか                     |
| `.veritas/improvements/<plan-id>/` | `plan.json` と、適用のたびに作る `approval-<n>.json` と `attempt-<n>.json`                      |
| `.veritas/generated-tests/`        | `veritas test generate` が書き出したファイル                                                    |
| `.veritas/cache/`                  | 結論の出たソルバーの結果、LLM の応答、mutation の実行を、署名付きで内容ごとに保存するキャッシュ |

## エンベロープのメタデータ

Veritas が実行ごとに書く JSON ファイル（`report.json` と mutator 自身のファイルを除く）は、`{ "meta": { ... }, "data": ... }` という形のエンベロープです。

```json
{
  "meta": {
    "schemaVersion": "1.0.0",
    "runId": "run-20261120T100618836Z-000-1951f4",
    "toolVersion": "0.1.2",
    "gitCommit": "8a0dfe77e920c63934c08149b2f0a7aa67aecaa0",
    "configHash": "26b755aea2820bc824e016aaa6c9c6a663f172075da0d22a449ae19ea1af9255",
    "sourceHash": "64bf135f24766bd2b631d31b80625951a3629b2c23f7d0b0deacc76437082b6b",
    "createdAt": "2026-11-20T10:06:20.072Z"
  },
  "data": []
}
```

| フィールド      | 意味                                               |
| --------------- | -------------------------------------------------- |
| `schemaVersion` | 成果物のスキーマのバージョン                       |
| `runId`         | その成果物を書いた実行                             |
| `createdAt`     | 成果物を書いた日時（ISO 8601、UTC）                |
| `toolVersion`   | Veritas のバージョン                               |
| `gitCommit`     | 分析したリポジトリの `HEAD`。git がなければ `null` |
| `configHash`    | 検証済みの設定のハッシュ                           |
| `sourceHash`    | 索引にしたソースファイルのハッシュ                 |

エンベロープを持てないファイル（ソルバーの入出力、Lean のソース、描画したレポート、mutator 自身のレポートのファイル）は、SHA-256 付きで `artifact-index.json` に載り、そのインデックスがメタデータを持ちます。描画したレポートにもメタデータを表示します。[Node API](/ja/reference/api) の `readArtifact` は、ファイルをスキーマで検証し、合わなければ拒否します。

## JSON Schema

設定と、成果物に含まれるレコードの JSON Schema は、リポジトリの [`schemas/`](https://github.com/under18dev/veritas/tree/main/schemas) にあります。

| スキーマ                                      | 対象                                       |
| --------------------------------------------- | ------------------------------------------ |
| `config.json`                                 | `.veritas/config.json`                     |
| `artifact-meta.json`                          | エンベロープのメタデータ                   |
| `run.json`、`stage-result.json`               | 実行と、そのステージの結果                 |
| `capability.json`                             | `veritas doctor` が報告するケイパビリティ  |
| `evidence-source.json`                        | 集めた出典                                 |
| `property.json`、`property-ir.json`           | Property と、その形式モデル（Property IR） |
| `test-case.json`、`test-property-edge.json`   | テストと、その Property との関係           |
| `mutant.json`                                 | mutant                                     |
| `formal-claim.json`                           | 形式的な主張                               |
| `test-assessment.json`                        | テストの評価                               |
| `finding.json`                                | finding                                    |
| `approval-ledger.json`                        | `.veritas/approvals.json`                  |
| `improvement-plan.json`、`patch-attempt.json` | 改善計画と、その適用の記録                 |

設計の考え方は [ADR 0002](/adr/0002-schemas-and-artifacts)（英語）にあります。

## 秘密情報の秘匿

成果物、レポート、ログ、トレースに書く前に秘密情報を取り除きます。`veritas report` が表示するとき、MCP のツールが返すとき、GitHub Action が出力やステップの要約を書くときにも、もう一度取り除きます。次のものを `[REDACTED]` に置き換えます。

- よくあるトークンの形式。Anthropic と OpenAI のキー（`sk-ant-...`、`sk-...`）、GitHub のトークン（`ghp_...`、`github_pat_...` と、ほかの `gh*_` で始まるもの）、AWS のアクセスキー ID、Slack のトークン、PEM の秘密鍵
- `token=...`、`password: ...`、`api_key=...` のような代入、URL に含まれる認証情報（`https://user:pass@host`）、`Authorization` ヘッダーの値
- 名前に `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY`、`PRIVATE_KEY`、`CREDENTIAL` を含む環境変数の値（8 文字以上のもの）
- 記録したコマンドの中の、`--token` や `--api-key` のような秘密情報を受け取るフラグの引数

ログとトレースには、環境変数の値もファイルの内容も含めません。LLM に送ったプロンプトも保存しません（`storage.storePrompts` は `false` しか受け付けません）。
