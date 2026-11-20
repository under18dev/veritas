# 設定

## 設定ファイルの場所

Veritas は、プロジェクトのルートにある `.veritas/config.json` から設定を読みます。`veritas init` は、検出したパッケージマネージャー、`tsconfig.json`、ソースとテストの glob をこのファイルに書き、それ以外の設定には既定値を使います。ファイルは [`schemas/config.json`](https://github.com/under18dev/veritas/blob/main/schemas/config.json) で検証され、未知のキーや不正な値はユーザーエラー（`CONFIG_INVALID`、終了コード 2）になります。エラーメッセージには、問題のあるフィールドがすべて並びます。

コードで書いた設定（プロジェクトのルートの `veritas.config.ts`、`veritas.config.mjs`、`veritas.config.js`）は、グローバルオプション `--allow-code-config` を付けたときだけ読み込みます。読み込むとプロジェクトのコードが実行されるためです。このオプションがなければ `CONFIG_CODE_NOT_ALLOWED` で失敗します。モジュールの default export は、JSON ファイルと同じ形のオブジェクトにします。JSON の設定とコードの設定が両方あるとエラー（`CONFIG_AMBIGUOUS`）になり、プロジェクトの外を指すシンボリックリンクの設定ファイルは読み込みを拒否します。

設定のハッシュ（`configHash`）はすべての成果物のメタデータに入るので、どの設定で実行したかが必ず記録に残ります。

`.veritas/config.json` と `.veritas/approvals.json` はコミットしてください。[GitHub Action](/ja/reference/github-action) はリポジトリにある設定を使います。一方、`.veritas/runs/` と `.veritas/cache/` はバージョン管理に入れないでください。git で管理されているキャッシュは無視されます。

## 設定例

`.veritas/config.json` には、既定値と違う設定だけを書けば足ります。JSON にはコメントを書けないので、説明は例の後に置きます。

```json
{
  "$schema": "https://veritas.invalid/schemas/config.json",
  "schemaVersion": "1.0.0",
  "project": { "packageManager": "pnpm", "tsconfig": "tsconfig.json" },
  "analysis": {
    "include": ["src/**/*.ts"],
    "testInclude": ["test/**/*.test.ts"]
  },
  "formal": { "integerDomain": { "min": "-1000000", "max": "1000000" } },
  "pbt": { "numRuns": 500 },
  "policy": {
    "confirmedViolation": "fail",
    "inconclusiveBehavior": "fail",
    "maxNewSurvivors": 0
  },
  "storage": { "retainRuns": 10 }
}
```

- `analysis.include` と `analysis.testInclude` は `init` が検出した glob です。ソースやテストが別の場所にあるときに変更します。
- `formal.integerDomain` は形式検証の範囲を広げます。範囲を正確に保つため、境界は 10 進数の文字列で書きます。
- `policy.inconclusiveBehavior: "fail"` にすると、判定できない結果が終了コード 4 になります。対象は、`unknown`、`timeout`、`unsupported`、`semantic_mismatch`、`error` の主張と、`partial`、`skipped`、`unsupported`、`timeout`、`cancelled` のステージです。CI のゲートに向いています。
- `policy.maxNewSurvivors: 0` にすると、範囲内の mutant が 1 つでも生き残れば失敗します。
- `storage.retainRuns: 10` で、新しいほうから 10 個の実行ディレクトリを残します。

同じ設定を `veritas.config.ts` で書くと次のようになります（`--allow-code-config` を付けたときだけ読み込みます）。

```ts
export default {
  project: { packageManager: 'pnpm', tsconfig: 'tsconfig.json' },
  analysis: { include: ['src/**/*.ts'], testInclude: ['test/**/*.test.ts'] },
  policy: { inconclusiveBehavior: 'fail', maxNewSurvivors: 0 },
};
```

## すべての設定

次の表は `schemas/config.json` から生成しています。生成部分は英語のままです。

<!--@include: ../../reference/_generated/configuration.md-->

## 主な設定

| 設定                                                                         | 既定値                                 | 意味                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources.web.enabled`、`sources.github.enabled`                              | `false`                                | ネットワーク上のソース。Web には `allowDomains` も必要で、GitHub は `sources.github.repo`（`owner/name`）を読みます。どちらも `--offline` では使いません                                                                                                                         |
| `sources.web.maxPages`、`maxDepth`、`maxChars`、`timeoutMs`、`maxDurationMs` | `30`、`1`、`200000`、`30000`、`120000` | クロールの上限。ページ数、リンクの深さ、保持する文字数、1 ページあたりの時間（本文の取得を含む）、クロール全体の時間です。時間内に取得できなかったページは skipped として報告します                                                                                              |
| `analysis.inferSpecsFromCode`                                                | `true`                                 | コードから推測した Property の候補を提案します。`false` にすると、コードから推測した候補は登録されず、ドキュメントなどの出典だけから Property を作ります                                                                                                                         |
| `mutation.mode`                                                              | `diff`                                 | mutation testing の想定する実行方法。変更範囲に絞るのは、モードによらず `--since` です。`diff` で `--since` がないときは、範囲内の全 mutant を実行したことをステージのメッセージに残します。`full` ではこのメッセージを出しません                                                |
| `formal.integerDomain`                                                       | `-10000` から `10000`                  | 形式検証で使う整数の範囲。安全な整数の範囲内で指定します                                                                                                                                                                                                                         |
| `formal.maxSolverMs`                                                         | `30000`                                | クエリ 1 件あたりのソルバーの制限時間                                                                                                                                                                                                                                            |
| `formal.maxArrayLength`                                                      | `3`                                    | 形式検証で配列の引数に用意する要素数（1〜8）。それより長い配列は検証の対象外です                                                                                                                                                                                                 |
| `pbt.numRuns`、`pbt.seed`                                                    | `1000`、Property ごとに導出            | Property-based テスト。`seed` を指定しなければ、Property の ID から決まる固定の seed を使うので、実行結果を再現できます                                                                                                                                                          |
| `llm.provider`                                                               | `none`                                 | LLM による自由記述の抽出。[LLM プロバイダー](/ja/guide/llm-providers)を参照してください。`llm.maxTokensPerRun` は 1 回の実行で使うトークンの上限です                                                                                                                             |
| `policy.confirmedViolation`                                                  | `fail`                                 | 確定した違反で終了コード 1 にします。`warn` にすると警告として報告します                                                                                                                                                                                                         |
| `policy.inconclusiveBehavior`                                                | `warn`                                 | `fail` にすると、判定できない結果で終了コード 4 になります。`warn` と `ignore` では終了コードは 0 ですが、verdict は `pass_with_warnings` のままで、判定できない項目をすべて並べます                                                                                             |
| `policy.maxNewSurvivors`                                                     | なし                                   | この実行の範囲（`--since` を付けたときはその変更）で生き残った mutant がこの数を超えると、終了コード 1 にします。mutation の結果がなければ判定できない扱いです                                                                                                                   |
| `policy.minPropertyCoverage`                                                 | なし                                   | accepted の Property のうち、`meaningful_with_evidence` のテストがあるものの割合（0〜1）がこれを下回ると、終了コード 1 にします。accepted の Property がなければ判定できない扱いです                                                                                             |
| `sandbox.allowNetworkWithoutIsolation`                                       | `false`                                | ネットワークを遮断できる Node.js 25 以上がなくても、プロジェクトのコードを実行します。指定しなければ、その結果は判定できないままです                                                                                                                                             |
| `storage.retainRuns`                                                         | `20`                                   | `.veritas/runs/` に残す実行ディレクトリの数。実行が終わるたびに、この数を超えた古い実行を削除します（今回の実行も数に含みます）。削除するのは、`artifact-index.json` に `trace.jsonl` が載っている、終わった実行の実ディレクトリだけなので、別のプロセスで実行中のものは残ります |
| `cache.enabled`                                                              | `true`                                 | `.veritas/cache/` の結果を再利用します（後述）                                                                                                                                                                                                                                   |
| `limits.memoryMb`                                                            | `2048`                                 | プロジェクトのコードの制限付き呼び出し、property-based テスト、プロジェクトのテストランナーと mutator、Z3 ソルバーのプロセスに設定する V8 ヒープの上限（MiB、256 以上）。Lean には制限をかけません。メモリが足りなくなった場合は `error` になり、結果としては扱いません          |

ポリシーの設定は、仕様書にある CI のポリシーを camelCase にしたものです。`block_on_confirmed_spec_violation` が `policy.confirmedViolation`（`fail` でブロック）、`max_new_survivors` が `policy.maxNewSurvivors`、`min_property_coverage` が `policy.minPropertyCoverage`、`inconclusive_behavior` が `policy.inconclusiveBehavior` に当たります。GitHub Action では `inconclusive` を入力としても指定できます。

## 値が 1 つしかない設定

いくつかの設定は、規則を明示するためだけにあり、受け付ける値は 1 つだけです。ほかの値を書くと、不正な設定として拒否します。

| 設定                                         | 受け付ける値 | 表している規則                                                       |
| -------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `analysis.requireApprovalForNormativeClaims` | `true`       | Property が `accepted` になるのは、明示的な承認の記録があるときだけ  |
| `improvement.testFilesOnly`                  | `true`       | `improve` はテストファイルを追加するだけで、本番のコードは編集しない |
| `improvement.autoApply`                      | `false`      | 計画を適用するには `--apply`、計画 ID、承認トークンが必要            |
| `storage.storePrompts`                       | `false`      | LLM に送ったプロンプトは実行の成果物に保存しない                     |
| `formal.rejectUnsupportedSemantics`          | `true`       | 形式検証の対象外のコードは `unsupported` とし、近似で済ませない      |
| `analysis.testFramework`                     | `vitest`     | 対応するテストランナーは Vitest                                      |
| `mutation.backend`                           | `mizchi`     | mutation のバックエンドは `@mizchi/mutator`                          |

## キャッシュ

`.veritas/cache/` には 3 種類の結果を保存します。

| 種類                                   | キー                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 結論の出た Z3 の結果（`sat`、`unsat`） | SMT クエリ、ソルバーのビルド、制限時間                                                                             |
| 成功した LLM の応答                    | プロバイダー、モデル、リクエストの内容そのもの                                                                     |
| 完了した mutation の実行               | `git ls-files` が列挙するすべてのファイルの内容、mutator・Vitest・Node.js のバージョン、設定、`--since` とスコープ |

結論の出なかった結果や失敗した結果は再利用しません。再利用した反例も JavaScript で再生し、再利用したことはステージのメッセージとソルバーの出力に残します。git がなければ mutation の結果はキャッシュしません。

エントリには、プロジェクトの外に置いた鍵で署名します。鍵の場所は `~/.cache/veritas/cache-key`（Windows では `%LOCALAPPDATA%\veritas\cache-key`）か、`VERITAS_CACHE_KEY_FILE` で指定したファイルです。別の鍵で署名されたエントリ（リポジトリと一緒に持ち込まれたもの、鍵のない新しい CI ランナーに復元したものなど）は、キャッシュにないものとして扱います。git で管理されているキャッシュは丸ごと無視します。ただし、mutation testing で実行するプロジェクト自身のテストからは鍵を読めてしまいます。信頼できないコードに対しては `cache.enabled: false` にしてください（[セキュリティモデル](/ja/concepts/security)を参照）。
