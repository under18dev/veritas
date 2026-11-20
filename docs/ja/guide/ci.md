# CI と GitHub Action

CI でも、Veritas の動き方は手元と同じです。実行ディレクトリを書き出し、verdict を表示し、CI が判断に使える終了コードで終わります。このページでは、GitHub Action、終了コードを決めるポリシー、ほかの CI での CLI の使い方を説明します。

## リポジトリに入れるもの

CI には設定ファイルが必要で、accepted な Property を使うなら決定の記録も必要です。`.veritas/config.json` と `.veritas/approvals.json` をコミットし、ほかは無視します。

```text
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

`.veritas/config.json` がないと、`veritas run` は `CONFIG_MISSING`（終了コード `2`）で止まります。

## 終了コードとポリシー

| 終了コード | verdict                                     | CI でのふつうの扱い  |
| ---------- | ------------------------------------------- | -------------------- |
| `0`        | `pass`、`pass_with_warnings`                | 成功                 |
| `1`        | `policy_failure`                            | 失敗                 |
| `2`        | 設定や使い方の誤り                          | ワークフローを直す   |
| `3`        | `tool_error`                                | 実行環境の問題       |
| `4`        | `inconclusive`（`fail` ポリシーのときだけ） | 運用に合わせて決める |

ポリシーは `.veritas/config.json` に書きます。

```json
{
  "policy": {
    "confirmedViolation": "fail",
    "inconclusiveBehavior": "warn",
    "maxNewSurvivors": 0,
    "minPropertyCoverage": 0.8
  }
}
```

| 設定                          | 値（既定）                         | 効果                                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policy.confirmedViolation`   | `fail` か `warn`（`fail`）         | 確定した仕様違反で終了コード `1` にするか                                                                                                                                                                                |
| `policy.inconclusiveBehavior` | `fail`、`warn`、`ignore`（`warn`） | `fail` なら、結論の出ていない結果（決着しなかった検証、partial や skipped のステージ）で終了コード `4` にします。`warn` と `ignore` では列挙するだけですが、verdict が `pass_with_warnings` より良くなることはありません |
| `policy.maxNewSurvivors`      | 整数（未設定）                     | この実行の範囲で生き残った mutant が上限を超えたら終了コード `1`。`--since` を付けた場合、範囲は変更部分です。mutation testing の結果がない実行では inconclusive になります                                              |
| `policy.minPropertyCoverage`  | 0 から 1（未設定）                 | accepted な Property のうち、`meaningful_with_evidence` のテストが一つ以上あるものの割合が下回ったら終了コード `1`。accepted な Property がなければ inconclusive になります                                              |

suspected の finding でポリシー違反になることはありません。測れなかったしきい値は inconclusive として扱い、通ったことにはしません。

## プルリクエストでは `--since` を使う

プルリクエストでは、mutation testing を変更部分に絞ります。

```bash
veritas run --profile standard --offline --since origin/main
```

`--since <ref>` には、その ref が clone に含まれている必要があります。`actions/checkout` では `fetch-depth: 0` で履歴をすべて取得してください。このとき `maxNewSurvivors` は、変更したコードで生き残った mutant だけを数えます。変更の外の mutant は意図して除いているので、それで mutation のステージが partial になることはありません。

## GitHub Action

`packages/github-action` の Action は、CLI と同じエンジンをオフラインで動かします。Action 自体は `node24` のランタイムで動きます。property-based testing と反例の再実行がネットワークなしでプロジェクトのコードを動かせるよう、ジョブで Node.js 25 以上を用意してください（例では 26 を使っています）。用意しないと、それらは実行されず、結果は inconclusive のままです。

`packages/github-action/examples/pull-request.yml` のワークフローです。

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

::: warning
この例では Action を `veritas/github-action@v1` として参照しています。ワークフローでの Action の参照方法は [GitHub Action リファレンス](/ja/reference/github-action)を確認してください。Action を使えない場合は、下の [CLI のワークフロー](#github-actions-で-cli-を使う)で、npm パッケージを使って同じ結果を得られます。
:::

### 入力と出力

| 入力                | 既定       | 意味                                                                                                        |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`、`standard`、`deep`                                                                                 |
| `working-directory` | `.`        | プロジェクトのディレクトリ                                                                                  |
| `since`             | （空）     | 比較の基準の SHA。空なら、`pull_request` ではプルリクエストの base SHA、`push` では更新前の head を使います |
| `inconclusive`      | `warn`     | `warn`、`fail`、`ignore`。指定しなければ設定ファイルの `policy.inconclusiveBehavior` を使います             |
| `summary`           | `true`     | ステップのサマリーを書くか                                                                                  |

| 出力                 | 中身                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `verdict`            | `pass`、`pass_with_warnings`、`policy_failure`、`tool_error`、`inconclusive`、`skipped` |
| `exit-code`          | Veritas の終了コード                                                                    |
| `run-id`             | run ID                                                                                  |
| `confirmed-findings` | 確定した finding の数                                                                   |
| `report-path`        | 実行の `run.json` のパス（ワークスペースからの相対パス）                                |
| `from-fork`          | フォークからのプルリクエストなら `true`                                                 |

変更が Markdown ファイル、`docs/` 以下のファイル、画像だけなら、verdict `skipped`、終了コード `0` で実行を省きます。実行ごとに `veritas replay <run-id>` が記録されるので、アップロードした成果物から手元で再現できます。

### フォークからのプルリクエスト

`pull_request` イベントであれば、フォークからのプルリクエストでも安全に動かせます。

- トークンを読まず、ネットワーク上の出典も有効にしません。
- 例のように、権限は `contents: read` だけにし、`persist-credentials: false` でチェックアウトしてください。
- `pull_request_target` と、フォークのプルリクエストに対する `workflow_run` は拒否します。権限のある環境で信頼できないコードを動かすことになるからです。
- レポートでは、トークンの形をした値と秘密の環境変数の値を伏せます。

プロジェクトのテストは実行されます（mutation testing がテストを動かします）。フォークのプルリクエストでは、ほかのテストのジョブと同じく、秘密情報なしで動きます。

### 成果物

実行結果は `.veritas/runs/` に保存されます。例のように、保存期間（ここでは 14 日）を決めてアップロードしてください。実行ディレクトリには、レポート（`report.html`、`report.md`、`report.sarif`）、すべての JSON の成果物、`trace.jsonl` が入っています。

## SARIF と code scanning

実行ごとに `report.sarif`（SARIF 2.1.0）が書き出され、`veritas report --format sarif` で最新の実行のものを出力できます。GitHub の code scanning に finding を表示するには、`github/codeql-action/upload-sarif` でアップロードします。このステップには `security-events: write` の権限が要り、フォークからのプルリクエストのワークフローにはこの権限が与えられません。アップロードは、同じリポジトリからのプルリクエストか push のときだけ行ってください。

## GitHub Actions で CLI を使う

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
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 26
      - run: npm ci
      - run: npx veritas run --profile standard --offline --since "${{ github.event.pull_request.base.sha }}"
      - run: npx veritas report --format markdown >> "$GITHUB_STEP_SUMMARY"
        if: always()
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: veritas-runs
          path: .veritas/runs
          retention-days: 14
```

`@under18dev/veritas` がプロジェクトの devDependencies に入っていることを前提にしています。`run` のステップは、Veritas の終了コードでジョブを失敗させます。

## ほかの CI

Node.js が動く CI なら、どれでも CLI を使えます。手順は同じです。

```bash
npm ci
npx veritas run --profile standard --offline --since "$BASE_SHA"
status=$?
npx veritas report --format sarif > veritas.sarif
npx veritas report --format html > veritas.html
exit $status
```

- 結果をデータとして扱いたいときは `--json` を付けます。標準出力には JSON だけが出て、ログは標準エラー出力に出ます。
- `.veritas/runs/` はビルドの成果物として残してください。
- 環境変数 `CI` が設定されていると、`veritas improve --apply` は拒否されます。計画（`veritas improve --dry-run`）は実行できます。
- `--offline` は Veritas 自身のネットワークアクセスを止めるだけです。ジョブにネットワークがある限り、プロジェクトのテストはネットワークを使えます。
