# GitHub Action

Veritas の GitHub Action について、ワークフローの例、バージョンの固定方法、入力と出力、終了コード、対応するイベント、フォークからのプルリクエストを安全に扱うための規則をまとめます。Action は `veritas run` と同じ分析をオフラインで実行します。CI への組み込み方は [CI と GitHub Action](/ja/guide/ci) を参照してください。

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
          # The base commit is needed to compare against it and to skip documentation-only changes.
          fetch-depth: 0
          persist-credentials: false
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          # Node.js 25+ on PATH runs project code without network access.
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: under18dev/veritas/packages/github-action@v0.1.3
        with:
          profile: standard
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: veritas-runs
          path: .veritas/runs
          retention-days: 14
```

各部分の役割は次のとおりです。

- `permissions: contents: read` と `persist-credentials: false` により、ジョブのトークンは読み取り専用になり、チェックアウトにも保存されません。このジョブではプルリクエストのコードが動くので、push や秘密情報の読み取りができないようにしておく必要があります。
- `fetch-depth: 0` で履歴を取得し、プルリクエストのベースのコミットを使えるようにします。Action は `git diff <since>...HEAD` で変更されたファイルを列挙し、mutation testing の対象を変更に絞ります。
- `pnpm/action-setup` と `pnpm install` で、プロジェクトの依存パッケージをインストールします。mutation testing はプロジェクト自身の Vitest のテストを実行するためです。ほかのパッケージマネージャーを使う場合は、そのインストールコマンドに置き換えてください。
- `actions/setup-node` で、Action が使う Node.js を用意します（後述）。Node.js 25 以上を使ってください（例では 26）。
- `upload-artifact` に `if: always()` を付けると、Veritas のステップが失敗しても `.veritas/runs` が残り、失敗した実行の根拠を確かめたり、手元で再実行したりできます。保存期間も指定してください。

解析には、コミット済みの `.veritas/config.json` が必要です（`veritas init` で作ります）。設定がないまま解析まで進むと、Action は `CONFIG_MISSING`（終了コード 2）で失敗します。ドキュメントだけの変更は、設定を読む前に終わります。解析できないプロジェクト（`package.json` がない、または Vitest がない）でも設定は必須ではなく、有効な設定があれば `policy.inconclusiveBehavior` だけを使います。

## バージョンと Node.js

Action は、Veritas のリポジトリ内のパスとリリースのタグで指定します（`under18dev/veritas/packages/github-action@v<version>`）。各タグの `action.yml` は、同じバージョンの公開済み npm パッケージを `npx --yes @under18dev/veritas-github-action@<version>` で実行します。つまり、固定したタグがそのまま実行される Veritas のバージョンです。新しいバージョンにするときは、タグを変えてください。

composite action なので、Action に同梱したランタイムではなく、ジョブで `actions/setup-node` が用意した Node.js で動きます。property-based テストと反例の再生では、ネットワークを遮断できる Node.js 25 以上があるときだけプロジェクトのコードを呼び出します。それより古い Node.js では、これらの結果は作られず、判定できないままです（`sandbox.allowNetworkWithoutIsolation` を設定した場合を除く）。ステップの開始時に npm のレジストリからパッケージをダウンロードしますが、分析そのものはオフラインです。

## 入力

| 入力                | 既定値     | 意味                                                                                                                                                |
| ------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`、`standard`、`deep` のいずれか。`veritas run --profile` と同じステージを実行します                                                          |
| `working-directory` | `.`        | プロジェクトのディレクトリ（ワークスペースからの相対パス）。チェックアウトしたリポジトリの外は拒否します                                            |
| `since`             | `""`       | 差分チェックの基準のコミット。空なら、プルリクエストのベース SHA か、push の前のコミットを使います                                                  |
| `inconclusive`      | `""`       | `warn`、`fail`、`ignore` のいずれか。空なら設定の `policy.inconclusiveBehavior`、それもなければ `warn` を使います。詳しくは表の下を参照してください |
| `summary`           | `"true"`   | ステップの要約を書きます。`"false"` で書きません                                                                                                    |

実行は常にオフラインで、設定にかかわらず GitHub や Web のソースも LLM も使いません。`inconclusive` の効き方は次のとおりです。

- 分析を実行できないとき（`package.json` がない、Vitest が使えない）は、この値だけで決まります。`fail` なら終了コード 4、`warn` と `ignore` なら 0 です。
- 分析を実行したあとは、`fail` なら判定できない結果が 1 つでもあれば verdict を `inconclusive`（終了コード 4）にします。
- `warn` や `ignore` で設定を緩めることはできません。設定が `policy.inconclusiveBehavior: "fail"` なら、判定できない結果は終了コード 4 になります。

## 出力

| 出力                 | 意味                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict`            | `pass`、`pass_with_warnings`、`policy_failure`、`tool_error`、`inconclusive`。ドキュメントだけの変更では `skipped`                                                                                    |
| `exit-code`          | ステップの終了コード                                                                                                                                                                                  |
| `run-id`             | 実行の ID。何も実行しなかったときは空                                                                                                                                                                 |
| `confirmed-findings` | certainty が `confirmed` の finding の数                                                                                                                                                              |
| `report-path`        | 実行の `run.json` のパス。ワークスペースからの相対パスで、区切りは `/`。レポート（`report.json`、`report.md`、`report.html`、`report.sarif`）は同じディレクトリにあります。何も実行しなかったときは空 |
| `from-fork`          | フォークからのプルリクエストなら `true`、それ以外は `false`                                                                                                                                           |

後のステップからは、ステップの `id` を通じて読めます。Veritas が失敗したときも実行されるよう、`if: always()` を付けてください。

```yaml
- uses: under18dev/veritas/packages/github-action@v0.1.3
  id: veritas
  with:
    profile: standard
    inconclusive: fail
- if: always()
  run: echo "verdict ${{ steps.veritas.outputs.verdict }}, run ${{ steps.veritas.outputs.run-id }}"
```

## 終了コード

| コード | 意味                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `0`    | 合格。警告がある場合、ドキュメントだけの変更で省略した場合、`inconclusive` が `fail` でないときの縮退（後述）を含みます |
| `1`    | ポリシー違反。仕様違反が確定したか、ポリシーの基準を満たさなかった                                                      |
| `2`    | 不正または安全でない呼び出し。拒否するイベント、不正な `working-directory`、設定がない・不正                            |
| `3`    | ツールのエラー。対応していないイベントを含みます                                                                        |
| `4`    | `fail` のポリシーで判定できなかった                                                                                     |

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

変更されたファイルは `git diff <since>...HEAD` で列挙するので、基準のコミットがチェックアウトに含まれている必要があります（例のように `fetch-depth: 0` を指定します）。含まれていなければ変更されたファイルを列挙できず、次の節で説明するドキュメントだけの変更の省略も行いません。

## 省略と縮退

変更されたファイルがすべて Markdown、`docs/` の下のファイル、画像（`png`、`jpg`、`jpeg`、`gif`、`svg`、`webp`、`bmp`、`ico`）のいずれかなら、Action は分析を省略します。`verdict` は `skipped`、終了コードは `0` です。

プロジェクトに `package.json` がないとき、または Vitest が使えないときは、Action は実行せずに `verdict: inconclusive` を報告します。終了コードは `warn` と `ignore` では `0`、`fail` では `4` です。理由はステップの要約に書きます。

## ステップの要約

`summary` が `"false"` でなければ、ステップの要約に、verdict、終了コード、実行の ID、フォークからのプルリクエストかどうか、certainty ごとの finding の数、ID 付きで最大 20 件の finding を書きます。詳しく調べるときは、手元で `veritas explain <finding-id>` を実行してください。各実行には、`veritas replay <run-id>` で再現するために必要な情報が記録されています。

## フォークに対する安全性

フォークからのプルリクエストには `pull_request` イベントで対応します。このイベントでは、GitHub は秘密情報を渡さず、トークンも読み取り専用にします。Action 自身もトークンを読まず、ネットワーク上のソースも有効にしません。

`pull_request_target` と、フォークによって起動された `workflow_run` は拒否します。どちらも、権限のあるワークフローの文脈とプルリクエストのコードを組み合わせてしまうためです。ワークフローは、例と同じく次の規則を守るように書いてください。

- `pull_request` のワークフローは、トップレベルに `permissions` を宣言し、読み取り専用にしている（`contents: read`、ほかはすべて `none`）
- プルリクエストのワークフローのジョブは、`secrets.*` や GitHub のトークンを参照しない
- すべての `actions/checkout` の手順で `persist-credentials: false` を指定している
- `pull_request_target` のワークフローは、プルリクエストの head SHA をチェックアウトしない

## 秘密情報の秘匿

出力、ステップの要約、すべての成果物では、よくあるトークンの形式（GitHub、Anthropic、OpenAI、AWS、Slack、秘密鍵、URL や `Authorization` ヘッダーに含まれる認証情報）と、秘密情報らしい名前の環境変数の値を `[REDACTED]` に置き換えます。[レポートと成果物](/ja/reference/reports#秘密情報の秘匿)を参照してください。
