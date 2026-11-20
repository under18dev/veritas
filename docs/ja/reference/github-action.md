# GitHub Action

Veritas の Action は、CLI と同じエンジンを GitHub Actions のランナー上でオフラインで動かします。定義は [`packages/github-action/action.yml`](https://github.com/under18dev/veritas/blob/main/packages/github-action/action.yml) にあり、`node24` のランタイムで動きます。CI への組み込み方は [CI と GitHub Action](/ja/guide/ci) を参照してください。

## ワークフローの例

推奨するワークフローは [`packages/github-action/examples/pull-request.yml`](https://github.com/under18dev/veritas/blob/main/packages/github-action/examples/pull-request.yml) です。

```yaml
name: veritas
on:
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          # Node.js 25+ on PATH runs project code without network access.
          node-version: 26
      - run: pnpm install --frozen-lockfile
      - uses: veritas/github-action@v1
        with:
          profile: standard
      - uses: actions/upload-artifact@v4
        with:
          name: veritas-runs
          path: .veritas/runs
          retention-days: 14
```

各部分の役割は次のとおりです。

- `permissions: contents: read` と `persist-credentials: false` により、ジョブのトークンは読み取り専用になり、チェックアウトにも保存されません。このジョブではプルリクエストのコードが動くので、push や秘密情報の読み取りができないようにしておく必要があります。
- Action 自体は `node24` で動きますが、ジョブには Node.js 25 以上を用意してください（例では 26）。property-based テストと反例の再生では、ネットワークを遮断できる Node.js があるときだけプロジェクトのコードを呼び出します。そうした Node.js がなければ、これらの結果は作られず、判定できないままです（`sandbox.allowNetworkWithoutIsolation` を設定した場合を除く）。
- Action の前に、プロジェクトの依存パッケージをインストールします。mutation testing はプロジェクト自身の Vitest のテストを実行するためです。
- `.veritas/runs` を保存期間付きの artifact としてアップロードしておくと、実行の根拠を後から確かめたり、手元で再実行したりできます。

多くの場合、2 か所を書き換える必要があります。`pnpm install` の手順はランナーで pnpm が使えることを前提にしているので、`pnpm/action-setup` などで用意するか、使っているパッケージマネージャーのインストールコマンドに置き換えてください。また、`uses:` の行は、Action を取得する場所に合わせてください。

プロジェクトには、コミット済みの `.veritas/config.json` が必要です（`veritas init` で作ります）。ない場合、Action は `CONFIG_MISSING`（終了コード 2）で失敗します。

## 入力

| 入力                | 既定値     | 意味                                                                                                                                  |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`、`standard`、`deep` のいずれか。`veritas run --profile` と同じステージを実行します                                            |
| `working-directory` | `.`        | プロジェクトのディレクトリ（ワークスペースからの相対パス）。チェックアウトしたリポジトリの外は拒否します                              |
| `since`             | `""`       | 差分チェックの基準のコミット。空なら、プルリクエストのベース SHA か、push の前のコミットを使います                                    |
| `inconclusive`      | `warn`     | `warn`、`fail`、`ignore` のいずれか。`fail` では、判定できない結果が 1 つでもあれば verdict を `inconclusive`（終了コード 4）にします |
| `summary`           | `"true"`   | ステップの要約を書きます。`"false"` で書きません                                                                                      |

実行は常にオフラインで、設定にかかわらず GitHub や Web のソースも LLM も使いません。`inconclusive` の入力は、結果を厳しくする方向にしか働きません。設定に `policy.inconclusiveBehavior: "fail"` があれば、入力が `warn` でも、判定できない結果は終了コード 4 になります。

## 出力

| 出力                 | 意味                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `verdict`            | `pass`、`pass_with_warnings`、`policy_failure`、`tool_error`、`inconclusive`。ドキュメントだけの変更では `skipped` |
| `exit-code`          | ステップの終了コード                                                                                               |
| `run-id`             | 実行の ID。何も実行しなかったときは空                                                                              |
| `confirmed-findings` | certainty が `confirmed` の finding の数                                                                           |
| `report-path`        | 実行の `run.json` のパス。`working-directory` からの相対パスで、区切りは `/`。何も実行しなかったときは空           |
| `from-fork`          | フォークからのプルリクエストなら `true`、それ以外は `false`                                                        |

後のステップからは、ステップの `id` を通じて読めます。

```yaml
- uses: veritas/github-action@v1
  id: veritas
  with:
    profile: standard
    inconclusive: fail
- if: always()
  run: echo "verdict ${{ steps.veritas.outputs.verdict }}, run ${{ steps.veritas.outputs.run-id }}"
```

## 終了コード

| コード | 意味                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| `0`    | 合格。警告がある場合、ドキュメントだけの変更で省略した場合、`warn` のもとで縮退した場合（後述）を含みます |
| `1`    | ポリシー違反が確定した                                                                                    |
| `2`    | 不正または安全でない呼び出し。拒否するイベント、不正な `working-directory`、設定がない・不正              |
| `3`    | ツールのエラー。対応していないイベントを含みます                                                          |
| `4`    | `fail` のポリシーで判定できなかった                                                                       |

verdict は CLI と同じです（[CLI リファレンス](/ja/reference/cli#verdict)を参照）。チェックに通ったことは、設定したチェックと範囲についての根拠であって、テストや実装が正しいことの形式的な証明ではありません。

## イベント

| イベント                                               | 動作                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `pull_request`                                         | プルリクエストのベース SHA との差分を調べます。フォークからのものにも対応 |
| `push`                                                 | push の前のコミットとの差分を調べます                                     |
| `workflow_dispatch`、`schedule`、`repository_dispatch` | 基準のコミットなしで全体を調べます                                        |
| `pull_request_target`                                  | 拒否します（終了コード 2）                                                |
| フォークのプルリクエストから起動された `workflow_run`  | 拒否します（終了コード 2）                                                |
| それ以外のイベント                                     | エラーにします（終了コード 3）                                            |

変更されたファイルは `git diff <since>...HEAD` で列挙するので、基準のコミットがチェックアウトに含まれている必要があります（たとえば `actions/checkout` で `fetch-depth: 0` を指定します）。含まれていなければ変更されたファイルを列挙できず、次の節で説明するドキュメントだけの変更の省略も行いません。

## 省略と縮退

変更されたファイルがすべて Markdown、`docs/` の下のファイル、画像（`png`、`jpg`、`jpeg`、`gif`、`svg`、`webp`、`bmp`、`ico`）のいずれかなら、Action は分析を省略します。`verdict` は `skipped`、終了コードは `0` です。

プロジェクトに `package.json` がないとき、または Vitest が使えないときは、Action は実行せずに `verdict: inconclusive` を報告します。終了コードは `warn` と `ignore` では `0`、`fail` では `4` です。理由はステップの要約に書きます。

## ステップの要約

`summary` が `"false"` でなければ、ステップの要約に、verdict、終了コード、実行の ID、フォークからのプルリクエストかどうか、certainty ごとの finding の数、ID 付きで最大 20 件の finding を書きます。詳しく調べるときは、手元で `veritas explain <finding-id>` を実行してください。各実行には、`veritas replay <run-id>` で再現するために必要な情報が記録されています。

## フォークに対する安全性

フォークからのプルリクエストには `pull_request` イベントで対応します。このイベントでは、GitHub は秘密情報を渡さず、トークンも読み取り専用にします。Action 自身もトークンを読まず、ネットワーク上のソースも有効にしません。

`pull_request_target` と、フォークによって起動された `workflow_run` は拒否します。どちらも、権限のあるワークフローの文脈とプルリクエストのコードを組み合わせてしまうためです。ワークフローでは、例と同じく `contents: read` だけを許可し、`persist-credentials: false` でチェックアウトしてください。Action のパッケージには、次の規則を確かめる検査（`checkWorkflowSafety`）が含まれており、Veritas 自身のテストで例のワークフローに適用しています。

- `pull_request` のワークフローは、トップレベルに `permissions` を宣言し、読み取り専用にしている（`contents: read`、ほかはすべて `none`）
- プルリクエストのワークフローのジョブは、`secrets.*` や GitHub のトークンを参照しない
- すべての `actions/checkout` の手順で `persist-credentials: false` を指定している
- `pull_request_target` のワークフローは、プルリクエストの head SHA をチェックアウトしない

## 秘密情報の秘匿

出力、ステップの要約、すべての成果物では、よくあるトークンの形式（GitHub、Anthropic、OpenAI、AWS、Slack、秘密鍵、URL や `Authorization` ヘッダーに含まれる認証情報）と、秘密情報らしい名前の環境変数の値を `[REDACTED]` に置き換えます。[レポートと成果物](/ja/reference/reports#秘密情報の秘匿)を参照してください。
