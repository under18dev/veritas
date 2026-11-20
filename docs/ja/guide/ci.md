# CI と GitHub Action

GitHub Action か CLI でプルリクエストに Veritas を実行する方法と、どの結果でビルドを失敗させるかの決め方を説明します。

先に `.veritas/config.json` をコミットしてください。accepted な Property があれば `.veritas/approvals.json` もコミットします。対応する `.gitignore` は[はじめに](/ja/guide/getting-started#結果を見る)にあります。設定ファイルがないと、`veritas run` は `CONFIG_MISSING`（終了コード `2`）で止まります。

## GitHub Action を追加する

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
      - uses: under18dev/veritas/packages/github-action@v0.1.2
        with:
          profile: standard
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: veritas-runs
          path: .veritas/runs
          retention-days: 14
```

- Action は `under18dev/veritas/packages/github-action@v<version>` で参照します。同じバージョンの `@under18dev/veritas-github-action` パッケージを、ジョブで用意した Node.js を使ってオフラインで実行します。
- Node.js 25 以上を用意してください。property-based testing と反例の再実行で、ネットワークを遮断して関数を動かすのに必要です。古い Node.js では、これらの検査は行わず、結果は inconclusive になります。
- `fetch-depth: 0` で、比較の基準になるコミットを取得します。
- `pnpm/action-setup` は、プロジェクトが pnpm を使う場合だけ必要です。
- `.veritas/runs/` をアップロードすると、レポート、JSON の成果物、`trace.jsonl` が残ります。どの実行も、手元で `veritas replay <run-id>` を使って再現できます。

### 入力

| 入力                | 既定       | 意味                                                                                         |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`、`standard`、`deep`                                                                  |
| `working-directory` | `.`        | プロジェクトのディレクトリ（ワークスペースからの相対パス）                                   |
| `since`             | （空）     | 比較の基準の SHA。空なら、`pull_request` ではプルリクエストの base、`push` では更新前の head |
| `inconclusive`      | （空）     | `warn`、`fail`、`ignore`。空なら設定ファイルの `policy.inconclusiveBehavior` を使います      |
| `summary`           | `true`     | ステップのサマリーを書くか                                                                   |

### 出力

| 出力                 | 中身                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `verdict`            | `pass`、`pass_with_warnings`、`policy_failure`、`tool_error`、`inconclusive`、`skipped`        |
| `exit-code`          | Veritas の終了コード                                                                           |
| `run-id`             | run ID                                                                                         |
| `confirmed-findings` | 確定した finding の数                                                                          |
| `report-path`        | 実行の `run.json` のパス（ワークスペースからの相対パス）。レポートは同じディレクトリにあります |
| `from-fork`          | フォークからのプルリクエストなら `true`                                                        |

変更が Markdown ファイル、`docs/` 以下のファイル、画像だけの場合は、verdict `skipped`、終了コード `0` で実行を省きます。

### フォークからのプルリクエスト

`pull_request` イベントでは、Action は次のように動きます。

- トークンを読まず、ネットワーク上の出典も有効にしません。
- `pull_request_target` と、フォークのプルリクエストに対する `workflow_run` は拒否します。高い権限で信頼できないコードを動かすことになるからです。
- レポートでは、トークンの形をした値と秘密の環境変数の値を伏せます。

例のとおり、権限は `contents: read` だけにし、`persist-credentials: false` でチェックアウトしてください。mutation testing はプルリクエストのテストを実行します。フォークのプルリクエストでは、ほかのテストのジョブと同じく、秘密情報なしで動きます。

## ビルドを失敗させる条件を決める

| 終了コード | verdict                                     |
| ---------- | ------------------------------------------- |
| `0`        | `pass`、`pass_with_warnings`                |
| `1`        | `policy_failure`                            |
| `2`        | 設定や使い方の誤り                          |
| `3`        | `tool_error`                                |
| `4`        | `inconclusive`（`fail` ポリシーのときだけ） |

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

| 設定                          | 値（既定）                         | 効果                                                                                                                                                                    |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.confirmedViolation`   | `fail`、`warn`（`fail`）           | 確定した仕様違反で終了コード `1` にする                                                                                                                                 |
| `policy.inconclusiveBehavior` | `fail`、`warn`、`ignore`（`warn`） | `fail` なら、結論の出ていない結果（決着しなかった検証、partial や skipped のステージ）で終了コード `4`。それ以外では列挙だけで、verdict は良くても `pass_with_warnings` |
| `policy.maxNewSurvivors`      | 整数（未設定）                     | 実行の範囲で生き残った mutant が上限を超えたら終了コード `1`。`--since` では範囲は変更部分。mutation testing の結果がなければ inconclusive                              |
| `policy.minPropertyCoverage`  | 0〜1（未設定）                     | `meaningful_with_evidence` のテストがある accepted な Property の割合が下回ったら終了コード `1`。accepted な Property がなければ inconclusive                           |

suspected の finding でビルドが失敗することはなく、測れなかったしきい値は inconclusive になります。

## 変更部分だけを検査する

```bash
veritas run --profile standard --offline --since origin/main
```

`--since <ref>` は、mutation testing をその ref からの変更部分に絞ります。ref は clone に含まれている必要があります（`fetch-depth: 0`）。変更の外の mutant は実行せず、それで mutation のステージが partial になることはありません。

## code scanning に finding を表示する

実行ごとに `report.sarif`（SARIF 2.1.0）が書き出され、`veritas report --format sarif` で最新のものを出力できます。`github/codeql-action/upload-sarif` でアップロードしてください。このステップには `security-events: write` の権限が要り、フォークのプルリクエストのワークフローにはこの権限が与えられません。push と、同じリポジトリからのプルリクエストのときだけ実行してください。

## GitHub のワークフローで CLI を使う

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

プロジェクトの devDependencies に `@under18dev/veritas` が入っている必要があります。`veritas run` のステップは、終了コードでジョブを失敗させます。

## ほかの CI で CLI を使う

```bash
npm ci
npx veritas run --profile standard --offline --since "$BASE_SHA"
status=$?
npx veritas report --format sarif > veritas.sarif
npx veritas report --format html > veritas.html
exit $status
```

- `--json` を付けると、標準出力には JSON だけが、ログは標準エラー出力に出ます。
- `.veritas/runs/` はビルドの成果物として残してください。
- 環境変数 `CI` が空、`false`、`0` 以外の値だと、`veritas improve --apply` は拒否されます。`veritas improve --dry-run` は CI でも実行できます。
- `--offline` は Veritas のネットワークアクセスを止めます。テストは、ジョブにあるネットワークをそのまま使えます。
