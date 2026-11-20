# CLI リファレンス

`veritas` コマンドは、Vitest を使う TypeScript / JavaScript プロジェクトに対して Veritas のパイプラインを実行します。どのコマンドも [Node API](/ja/reference/api)、[MCP サーバー](/ja/reference/mcp)、[GitHub Action](/ja/reference/github-action) と同じエンジンを通り、`.veritas/runs/<run-id>/` に同じ成果物を書き出します（[レポートと成果物](/ja/reference/reports)を参照）。

```bash
veritas [グローバルオプション] <command> [オプション]
```

## 機械可読な出力

`--json` を付けると、stdout には JSON の値がちょうど 1 つだけ出力され、進捗メッセージやログはすべて stderr に出ます。ヘルプとバージョン（`{"status":"ok","help":"..."}`、`{"status":"ok","version":"..."}`）も、エラーも同じです。

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

エラーには必ず変わらない `code`（`CONFIG_MISSING`、`NO_RUN`、`ROOT_NOT_FOUND`、`IMPROVE_APPLY_IN_CI` など）があり、多くの場合は対処方法を示す `hint` も付きます。`--log-format json` が変えるのは stderr のログ（1 行に 1 つの JSON オブジェクト）だけで、stdout には影響しません。

`veritas report --json` は `veritas report --format json` と同じです。`--json` と json 以外の `--format` を同時に指定すると、ユーザーエラー（`FORMAT_CONFLICT`）になります。

## 終了コード

| コード | 意味                                                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`    | 成功。ただし、確認が必要な finding がある場合や、`warn` / `ignore` のポリシーで判定できない結果がある場合、verdict は `pass_with_warnings` になります                       |
| `1`    | ポリシー違反が確定した。`policy.confirmedViolation: fail` のもとで確定した仕様違反があるか、`policy.maxNewSurvivors` や `policy.minPropertyCoverage` の基準を満たさなかった |
| `2`    | 設定またはユーザーのエラー。引数の誤り、設定ファイルがない・不正、存在しない ID、拒否された操作など                                                                         |
| `3`    | ツールまたは実行環境のエラー。ステージの失敗、ソルバーや子プロセスの異常終了など                                                                                            |
| `4`    | 設定したポリシーのもとで判定できなかった（`policy.inconclusiveBehavior: fail`）                                                                                             |

ポリシー違反にできるのは `confirmed` の finding だけで、`suspected` の finding で失敗することはありません。`unknown`、`timeout`、`unsupported` を成功として数えることもありません。`warn` や `ignore` のもとでは終了コードは `0` のままですが、verdict は `pass_with_warnings` にとどまり、理由の一覧にそれぞれが載ります。

`veritas improve` と `veritas test replay` は同じコードを使いますが、意味はコマンドごとに異なります。後述の各コマンドの説明を参照してください。

## verdict

ステージを実行するコマンド（`discover`、`analyze`、`mutate`、`prove`、`run`、`replay`）は、最後にポリシーの判定（verdict）を出し、`run.json` に記録します。

| verdict              | 終了コード | 条件                                                                                                                   |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pass`               | `0`        | 確認が必要な finding も、判定できない結果もない                                                                        |
| `pass_with_warnings` | `0`        | 確認が必要な finding がある、確定した違反をポリシーで警告扱いにした、または `warn` / `ignore` で判定できない結果がある |
| `policy_failure`     | `1`        | `confirmedViolation: fail` のもとで違反が確定した、またはポリシーの基準を満たさなかった                                |
| `tool_error`         | `3`        | ステージが `error` または `failed` で終わった                                                                          |
| `inconclusive`       | `4`        | `inconclusiveBehavior: fail` のもとで、判定できないステージや主張がある                                                |

判定は、基準と確定した違反、ツールのエラー、判定できない結果の順に調べます。そのため、確定した違反とステージの失敗が両方ある実行は `policy_failure` になります。

## 環境変数

| 変数                                  | 効果                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `VERITAS_DEBUG=1`                     | `--debug` と同じ                                                                                                               |
| `VERITAS_ACTOR`                       | `--actor` を指定しないときに、判断を記録する人や計画を承認する人として使う名前（git の `user.name` より優先）                  |
| `VERITAS_SANDBOX_NODE`                | ネットワークを遮断してプロジェクトのコードを実行するための Node.js 25 以上の実行ファイル                                       |
| `VERITAS_CACHE_KEY_FILE`              | キャッシュのエントリに署名する鍵の場所（既定は `~/.cache/veritas/cache-key`、Windows では `%LOCALAPPDATA%\veritas\cache-key`） |
| `CI`                                  | 明示的に false を表す値以外が設定されていると、`improve --apply` は実行を拒否する                                              |
| `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` | LLM プロバイダー `claude` と `openai` の認証情報（[LLM プロバイダー](/ja/guide/llm-providers)を参照）                          |

## コマンドとオプション

この節の残りは CLI 自体から生成しているので、インストールしたバージョンと常に一致します。生成部分は英語のままです。

<!--@include: ../../reference/_generated/cli.md-->

## コマンドごとの補足

### セットアップ: `init`、`doctor`

`init` はパッケージマネージャー、`tsconfig.json`、ソースとテストの glob を検出し、`.veritas/config.json` を書き出します。既存の設定は `--force` を付けない限り上書きしません。プロジェクトが Vitest を使っていなければ `VITEST_NOT_FOUND` で失敗します。`doctor` は各ケイパビリティ（`node`、`git`、`package_manager`、`typescript`、`vitest`、`mutator`、`fast_check`、`z3`、`lean`、`llm`、`network`、`sandbox`）の状態と、それぞれがどの機能に影響するかを一覧にします。LLM の CLI について読むのはログイン状態だけで、アカウントの詳細は読みません。

### ステージ: `discover`、`analyze`、`mutate`、`prove`、`run`

各コマンドは決まったステージの列を実行します。依存するステージが先に実行されます。

| コマンド                 | ステージ                                          | 既定のネットワーク利用     |
| ------------------------ | ------------------------------------------------- | -------------------------- |
| `discover`               | discover                                          | 設定で有効にしたソースのみ |
| `analyze`                | index, discover, spec, map, assess                | なし（オフライン）         |
| `mutate`                 | index, discover, spec, map, mutate, assess        | なし（オフライン）         |
| `prove`                  | index, discover, spec, map, prove, assess, report | なし（オフライン）         |
| `run --profile quick`    | index, discover, spec, map, assess, report        | 設定で有効にしたソースのみ |
| `run --profile standard` | quick + mutate                                    | 設定で有効にしたソースのみ |
| `run --profile deep`     | standard + pbt, prove                             | 設定で有効にしたソースのみ |

`--offline` を付けると、Veritas 自身はネットワークにまったくアクセスしません（GitHub や Web のソースも LLM も使いません）。ただし、mutation testing で実行するプロジェクト自身のテストは、この指定では制限されません。[信頼できないリポジトリ](/ja/guide/untrusted-repositories)を参照してください。レポートのファイル（`report.json`、`report.md`、`report.html`、`report.sarif`）を書き出すのは、report ステージを含むコマンドだけです。

`--since <ref>` は mutation testing の対象を、git の ref からの変更に絞ります。指定しない場合、`mutation.mode: "diff"` でも範囲内のすべての mutant を実行し、そのことをステージのメッセージに残します。`--include-proposed` を付けると、まだ誰も accepted にしていない Property も検証します。その結果は `suspected` のままです。

`prove --engine lean` は Lake 経由で Lean 4（別途インストール）を使います。既定は Z3 です。`mutate --import <file>` は mutator を実行する代わりに、既存の mutation-testing-elements のレポートを取り込みます。`--kill-matrix` とは併用できません。

### 仕様: `spec`

`spec accept` と `spec reject` は、判断した人、日時、理由を付けて `.veritas/approvals.json` に判断を追記します。判断した人は `--actor`、`VERITAS_ACTOR`、git の `user.name` の順に決まります。判断は、それを下したときの Property のバージョンにだけ適用されます。Property が `accepted` になるのは、この判断を記録したときだけです。[仕様の確定](/ja/guide/specifications)を参照してください。

### Property-based テスト: `test`

`test generate` は Vitest と fast-check のテストファイルを `.veritas/generated-tests/` に書き出すだけで、実行はしません。`test replay <pbt-id>` は、記録された property-based テストを同じ seed、実行回数、shrink の経路で再実行します。記録どおりの結果が再現すれば `0`、再現しなければ `4` で終了します。

### テストの改善: `improve`

`improve` の既定はドライランで、プロジェクトのファイルを一切変更しません。計画 ID と承認トークンを表示するので、適用するときは `--apply --plan <id> --approve <token>` を指定します。CI の中では適用を拒否します（`IMPROVE_APPLY_IN_CI`）。

| 終了コード | `improve` の結果                                                 |
| ---------- | ---------------------------------------------------------------- |
| `0`        | 計画ができた（ドライラン）、またはテストを改善した（適用）       |
| `1`        | ブロックされた                                                   |
| `2`        | 計画 ID やトークンが正しくない、または CI の中で適用しようとした |
| `3`        | ツールのエラー                                                   |
| `4`        | 安全な改善がない、または先に仕様の判断が必要                     |

[テストの改善](/ja/guide/improving-tests)を参照してください。

### 結果: `report`、`explain`、`replay`

`report` は最新の実行（または `--run <run-id>` で指定した実行）を、`text`（既定）、`json`、`markdown`、`html`、`sarif` のいずれかで、秘密情報を伏せて表示します。`explain <finding-id>` は finding の根拠の連鎖（引用した出典、Property、テスト、評価、mutant、ソルバーの主張）を表示します。`replay <run-id>` は、記録された実行を同じステージとオプションで再実行します。再実行は常にオフラインで、ネットワーク上のソースと LLM による抽出は繰り返しません。
