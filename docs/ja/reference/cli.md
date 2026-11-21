# CLI リファレンス

`veritas` のコマンドとオプション、終了コードと verdict、読み取る環境変数、JSON 出力のリファレンスです。パイプラインを実行するコマンド（`discover`、`analyze`、`mutate`、`prove`、`run`、`replay`）は、結果を `.veritas/runs/<run-id>/` に書き出します。各ファイルについては[レポートと成果物](/ja/reference/reports)を参照してください。

```bash
veritas [グローバルオプション] <command> [オプション]
```

```bash
veritas init --yes
veritas run --profile standard
veritas report --format html > report.html
veritas explain F-0b43c88cc3a6
```

## 終了コード

| コード | 意味                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`    | 成功。verdict が `pass_with_warnings` の場合もあります                                                                                                |
| `1`    | ポリシー違反。`policy.confirmedViolation: fail` で仕様違反が確定したか、`policy.maxNewSurvivors` または `policy.minPropertyCoverage` を満たさなかった |
| `2`    | ユーザーのエラー。引数の誤り、設定ファイルがない・不正、存在しない ID、拒否された操作                                                                 |
| `3`    | ツールのエラー。ステージの失敗、ソルバーや子プロセスの異常終了                                                                                        |
| `4`    | `policy.inconclusiveBehavior: fail` のもとで、判定できない結果があった                                                                                |

終了コード `1` になる理由は 2 つあります。1 つは、`policy.confirmedViolation` が `fail` のときに仕様違反が確定した場合です（種類が `spec_implementation_mismatch`、`counterexample`、`spec_violation_candidate` のいずれかで、certainty が `confirmed` の finding）。もう 1 つは、`policy.maxNewSurvivors` か `policy.minPropertyCoverage` を満たさなかった場合です。`suspected` の finding や、生き残った mutant のようなほかの確定した finding は、報告されますが失敗にはなりません。

`unknown`、`timeout`、`unsupported` は成功として数えません。`policy.inconclusiveBehavior` が `warn` か `ignore` なら終了コードは `0` ですが、verdict は `pass_with_warnings` になり、理由の一覧にそれぞれの結果が載ります。

`veritas improve` と `veritas test replay` では、一部のコードの意味が変わります。[コマンドごとの補足](#コマンドごとの補足)を参照してください。

## verdict

ステージを実行するコマンド（`discover`、`analyze`、`mutate`、`prove`、`run`、`replay`）は、最後に verdict を出し、`run.json` にも記録します。

| verdict              | 終了コード | 条件                                                                                                                                         |
| -------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`               | `0`        | 確認が必要な finding も、判定できない結果もない                                                                                              |
| `pass_with_warnings` | `0`        | 確認が必要な finding がある、確定した違反を警告として扱った（`confirmedViolation: warn`）、または `warn` / `ignore` で判定できない結果がある |
| `policy_failure`     | `1`        | `confirmedViolation: fail` で違反が確定した、またはポリシーの基準を満たさなかった                                                            |
| `tool_error`         | `3`        | ステージが `error` または `failed` で終わった                                                                                                |
| `inconclusive`       | `4`        | `inconclusiveBehavior: fail` で、判定できないステージや主張がある                                                                            |

複数に当てはまるときは、`policy_failure`、`tool_error`、`inconclusive` の順に優先します。

## JSON 出力

グローバルオプション `--json` を付けると、stdout には JSON の値が 1 つだけ出力され、進捗メッセージやログは stderr に出ます。ヘルプとバージョン（`{"status":"ok","help":"..."}`、`{"status":"ok","version":"..."}`）も、エラーも JSON です。

```json
{
  "status": "error",
  "category": "user",
  "code": "USAGE",
  "message": "unknown option '--frobnicate'",
  "hint": "run `veritas --help`",
  "exitCode": 2
}
```

`code` はエラーの種類（`CONFIG_MISSING`、`NO_RUN`、`ROOT_NOT_FOUND` など）を、`hint` は対処方法を示します。`--log-format json` を付けると、stderr のログが 1 行に 1 つの JSON オブジェクトになります。stdout は変わりません。

`veritas report --json` は `veritas report --format json` と同じです。`--json` と json 以外の `--format` を一緒に指定すると、ユーザーのエラー（`FORMAT_CONFLICT`）になります。

## 環境変数

| 変数                                  | 効果                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `VERITAS_DEBUG=1`                     | `--debug` と同じです                                                                                                         |
| `VERITAS_ACTOR`                       | `--actor` を指定しないときに、仕様の判断や承認に記録する名前です。ないときは git の `user.name` を使います                   |
| `VERITAS_SANDBOX_NODE`                | ネットワークを遮断してプロジェクトのコードを実行するための、Node.js 25 以上のパスです                                        |
| `VERITAS_CACHE_KEY_FILE`              | キャッシュに署名する鍵のファイルです（既定は `~/.cache/veritas/cache-key`、Windows では `%LOCALAPPDATA%\veritas\cache-key`） |
| `CI`                                  | false を表す値以外が設定されていると、`improve --apply` は実行を拒否します                                                   |
| `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` | LLM プロバイダー `claude` と `openai` の認証情報です（[LLM プロバイダー](/ja/guide/llm-providers)を参照）                    |

## コマンドとオプション

次の一覧は CLI のヘルプから生成しているため、英語のままです。

<!--@include: ../../reference/_generated/cli.md-->

## コマンドごとの補足

### `init` と `doctor`

`init` はパッケージマネージャー、`tsconfig.json`、ソースとテストの glob を検出して、`.veritas/config.json` を書き出します。パッケージマネージャーは git にコミットされたロックファイルで決めます。コミットされたものがなければ `package.json` の `packageManager` フィールドを使い、それもなければディスク上にあるだけのロックファイルを使います。npm のプロジェクトで一度 pnpm を実行して `pnpm-lock.yaml` が残っていても、pnpm のプロジェクトとは判定しません。ソースの glob には、ルートと、`pnpm-workspace.yaml`（`packages:`）または `package.json` の `workspaces` で宣言した各 workspace パッケージの `src/`（または `lib/`）が入ります（パスそのものか、末尾が `*` のパターンに対応）。テストの glob には、`*.test.*` と `*.spec.*` に加えて、`test.ts`（`.tsx`、`.js`、`.mjs` も）という名前のファイルと `__tests__/` の下のファイルも入ります。ただし、そのようなファイルが `vitest` から import している場合に限ります。既存の設定は `--force` を付けない限り上書きしません。プロジェクトが Vitest を使っていなければ、`VITEST_NOT_FOUND` で失敗します。

`doctor` は、各ケイパビリティ（`node`、`git`、`package_manager`、`typescript`、`vitest`、`mutator`、`fast_check`、`z3`、`lean`、`llm`、`network`、`sandbox`）の状態と、それが影響する機能を一覧にします。mutator、fast-check、Z3 は、プロジェクトにインストールされていればそれを使い、なければ Veritas と一緒にインストールされたものを使います。どちらを使うかも `doctor` に表示されます。LLM の CLI については、ログインしているかどうかだけを確かめます。

### ステージを実行するコマンド

| コマンド                 | ステージ                                          | ネットワークの利用           |
| ------------------------ | ------------------------------------------------- | ---------------------------- |
| `discover`               | discover                                          | 設定で有効にしたソースと LLM |
| `analyze`                | index, discover, spec, map, assess                | なし                         |
| `mutate`                 | index, discover, spec, map, mutate, assess        | なし                         |
| `prove`                  | index, discover, spec, map, prove, assess, report | なし                         |
| `run --profile quick`    | index, discover, spec, map, assess, report        | 設定で有効にしたソースと LLM |
| `run --profile standard` | quick + mutate                                    | 設定で有効にしたソースと LLM |
| `run --profile deep`     | standard + pbt, prove                             | 設定で有効にしたソースと LLM |
| `replay`                 | 記録された実行と同じステージ                      | なし                         |

`--offline` を付けると、Veritas 自身はネットワークにアクセスしません。GitHub や Web のソースも LLM も使いません。ただし、mutation testing で実行するプロジェクト自身のテストは制限しません。テストもネットワークから切り離す方法は、[信頼できないリポジトリ](/ja/guide/untrusted-repositories)を参照してください。

レポートのファイルを実行ディレクトリに書くのは、report ステージを含む `run` と `prove`、およびそれらを `replay` したときだけです。`veritas report` を使えば、どの実行からでもレポートを作れます。

`--since <ref>` を付けると、mutation testing の対象を、その git の ref から変更されたコードに絞ります。`--include-proposed` を付けると、accepted でない Property も検査します。それらから出た finding は `suspected` 以下になります。

`prove --engine lean` は、別途インストールした Lean 4 と Lake を使います。既定のエンジンは Z3 です。`mutate --import <file>` は、mutator を実行せずに既存の mutation-testing-elements のレポートを読み込みます。`--kill-matrix` とは一緒に使えません。

### `spec`

`spec accept` と `spec reject` は、判断した人、日時、理由を `.veritas/approvals.json` に追記します。判断した人の名前は `--actor`、`VERITAS_ACTOR`、git の `user.name` の順に決まります。判断は、そのときの Property のバージョンにだけ効きます。Property の内容が変わったら、もう一度判断してください。Property が `accepted` になるのは、判断を記録したときだけです。[仕様の確定](/ja/guide/specifications)を参照してください。

### `test`

`test generate` は Vitest と fast-check のテストファイルを `.veritas/generated-tests/` に書き出します。実行はしません。`test replay <pbt-id>` は、記録された property-based テストを、同じ seed、実行回数、shrink の経路で実行し直します。記録どおりの結果が出れば `0`、出なければ `4` で終了します。

### `improve`

`--apply` を付けなければドライランになり、プロジェクトのファイルは変更せずに、計画 ID と承認トークンを表示します。計画を適用するには `improve --apply --plan <id> --approve <token>` を実行します。CI の中では適用を拒否します（`IMPROVE_APPLY_IN_CI`）。

| 終了コード | 結果                                                             |
| ---------- | ---------------------------------------------------------------- |
| `0`        | 計画ができた（ドライラン）、またはテストを改善した（適用）       |
| `1`        | ブロックされた                                                   |
| `2`        | 計画 ID やトークンが正しくない、または CI の中で適用しようとした |
| `3`        | ツールのエラー                                                   |
| `4`        | 安全な改善がない、または先に仕様の判断が必要                     |

[テストの改善](/ja/guide/improving-tests)を参照してください。

### `report`、`explain`、`replay`

`report` は、最新の実行（`--run` を付けたときはその実行）を、`text`（既定）、`json`、`markdown`、`html`、`sarif` のいずれかで表示します。`explain <finding-id>` は、finding の根拠（引用した出典、Property、テスト、評価、mutant、ソルバーの主張）を表示します。`replay <run-id>` は、記録された実行を同じステージとオプションで実行し直します。再実行は常にオフラインです。
