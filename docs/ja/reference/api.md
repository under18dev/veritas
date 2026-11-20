# Node API

`@under18dev/veritas` が Node.js 向けに公開している関数と型をまとめます。各関数は、対応する `veritas` コマンドと同じステージを実行し、`.veritas/runs/<run-id>/` に同じファイルを書き、同じ verdict と終了コードを返します。

```bash
pnpm add -D @under18dev/veritas
```

パッケージは ESM のみで、Node.js 24 以上が必要です。

```ts
import { analyze, run } from '@under18dev/veritas';

const result = await analyze({ root: '/path/to/project' });
console.log(result.decision.verdict, result.decision.exitCode); // 例: "pass_with_warnings", 0

for (const finding of result.findings) console.log(finding.id, finding.certainty, finding.title);

const deep = await run({ root: '/path/to/project', profile: 'deep', offline: true });
console.log(deep.runId, deep.dir);
```

## ステージの実行

| 関数                           | 対応する CLI       | ステージ                                                     | `offline` の既定 |
| ------------------------------ | ------------------ | ------------------------------------------------------------ | ---------------- |
| `discover(options)`            | `veritas discover` | discover                                                     | `false`          |
| `analyze(options)`             | `veritas analyze`  | index, discover, spec, map, assess                           | `true`           |
| `mutate(options)`              | `veritas mutate`   | index, discover, spec, map, mutate, assess                   | `true`           |
| `prove(options)`               | `veritas prove`    | index, discover, spec, map, prove, assess, report            | `true`           |
| `run({ profile, ...options })` | `veritas run`      | プロファイル（`quick`、既定の `standard`、`deep`）のステージ | `false`          |
| `runVeritas(options)`          | なし               | 任意のステージの列。列の前にある依存ステージも実行する       | `false`          |

`COMMAND_STAGES`（`discover`、`analyze`、`mutate`、`prove`）と `PROFILE_STAGES`（プロファイルごと）に、これらのステージの列が入っています。

### オプション

`discover`、`analyze`、`mutate`、`prove`、`run` は `StageOptions` を受け取ります。これは `RunOptions` から `command` と `stages` を除いたものです。`runVeritas` は `RunOptions` をすべて受け取ります。

| オプション         | 型                                               | 意味                                                                                            |
| ------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `root`             | `string`                                         | プロジェクトのルート。必須                                                                      |
| `command`          | `string`                                         | `run.json` に記録するコマンド名（`runVeritas` のみ）                                            |
| `stages`           | `StageName[]`                                    | 実行するステージ（`runVeritas` のみ）                                                           |
| `profile`          | `'quick' \| 'standard' \| 'deep'`                | 記録するプロファイル。`run` はこれでステージを選ぶ                                              |
| `offline`          | `boolean`                                        | ネットワークにアクセスしない。GitHub や Web のソースも LLM も使わない                           |
| `localSourcesOnly` | `boolean`                                        | ローカルのソースだけを集めるが、設定した LLM は使う                                             |
| `sources`          | `('local' \| 'github' \| 'web')[]`               | 集めるソース。既定はローカルと、設定で有効にしたネットワーク上のソース                          |
| `web`              | `{ allowDomains?: string[]; maxPages?: number }` | Web の収集に対する上書き。`--allow-domain` と `--max-pages` に当たる                            |
| `since`            | `string`                                         | git の ref。`--since` と同じく mutation testing を変更範囲に絞る                                |
| `scope`            | `string[]`                                       | mutation の対象にするソースの glob。`--scope` に当たる                                          |
| `mutationReport`   | `string`                                         | mutator を実行する代わりに取り込む mutation-testing-elements のレポート（プロジェクト内のパス） |
| `killMatrix`       | `boolean`                                        | すべての mutant に対して、それを通るテストをすべて実行する（遅い）                              |
| `includeProposed`  | `boolean`                                        | accepted でない Property も検査する。そこから出た finding は `suspected` 以下                   |
| `formalEngine`     | `'z3' \| 'lean'`                                 | 適合性の主張に使うバックエンド（mutant の等価性は常に Z3）。既定は `formal.backend`             |
| `propertyIds`      | `string[]`                                       | 検証する Property を絞る                                                                        |
| `allowCodeConfig`  | `boolean`                                        | プロジェクトのコードを実行する `veritas.config.{ts,mjs,js}` の読み込みを許可する                |
| `gitRoot`          | `string`                                         | `root` が `.git` のないコピーのとき、その git のリビジョンと履歴を持つリポジトリ                |
| `signal`           | `AbortSignal`                                    | 実行中のステージと、それが起動した子プロセスを中止する                                          |
| `log`              | `(message: string) => void`                      | 進捗のメッセージ（info レベル以上）                                                             |
| `logger`           | `LogSink`                                        | debug レベルを含む、すべての構造化イベント                                                      |
| `llmProvider`      | `LlmProvider \| null`                            | 設定したものの代わりに使う LLM プロバイダー（テストなど）。`null` を渡すと LLM を使わない       |

### 戻り値

ステージを実行する関数は、いずれも `RunSummary` を返します。

| フィールド | 型               | 意味                                                        |
| ---------- | ---------------- | ----------------------------------------------------------- |
| `runId`    | `string`         | 実行の ID。例: `run-20261120T100618836Z-000-1951f4`         |
| `dir`      | `string`         | `.veritas/runs/<run-id>/` の絶対パス                        |
| `run`      | `Run`            | `run.json` の内容。ステージ、オプション、状態、verdict など |
| `findings` | `Finding[]`      | 実行で見つかった finding                                    |
| `decision` | `PolicyDecision` | CLI と同じ `{ verdict, exitCode, reasons }`                 |

`decision.exitCode` は [CLI の終了コード](/ja/reference/cli#終了コード)に従い、`decision.verdict` は `pass`、`pass_with_warnings`、`policy_failure`、`tool_error`、`inconclusive` のいずれかです。ステージが失敗しても Promise は reject されません。失敗は `run.stages` に記録され、判定に反映されます。

### エラー

入力が不正なとき、設定がないとき、存在しない ID を指定したときは、`VeritasError` を投げます。`category`（`user`、`tool`、`policy`、`inconclusive`）は終了コード 2、3、1、4 に対応し、`exitCode` にそのコードが入ります。`code` は `CONFIG_MISSING` や `NO_RUN` のような変わらない識別子で、`hint` は対処方法です。`ExitCode` は定数のオブジェクト（`Success`、`PolicyFailure`、`UserError`、`ToolError`、`Inconclusive`）として公開しています。

```ts
import { ExitCode, readLatest, VeritasError } from '@under18dev/veritas';

try {
  readLatest('/path/to/project', 'findings');
} catch (error) {
  if (error instanceof VeritasError && error.code === 'NO_RUN') console.error(error.hint);
  else throw error;
}
```

## 結果を読む

| エクスポート                               | 用途                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `readArtifact(root, runId, name)`          | 実行の成果物を 1 つ読み、スキーマで検証する。`{ meta, data }` を返す                      |
| `readLatest(root, name)`                   | その成果物を持つ最新の実行から同じように読む。`{ runId, meta, data }` を返す              |
| `latestRunWith(root, name)`                | その成果物を持つ最新の実行の ID。なければ `null`                                          |
| `ARTIFACTS`                                | 成果物の名前と、そのファイル名・スキーマ                                                  |
| `explainFinding(root, findingId)`          | finding の根拠の連鎖（`veritas explain`）。出典、文、Property、テスト、評価、mutant、主張 |
| `buildReportInput(root, runId?)`           | 実行からレポートのデータを集める（既定は最新の実行）                                      |
| `renderReport(input, format)`              | `text`、`json`、`markdown`、`html`、`sarif` のいずれかで描画する                          |
| `renderCiSummary(input, { artifactUrl? })` | CI 向けの短い Markdown の要約を作る。アップロードした実行へのリンクも付けられる           |
| `REPORT_FILES`                             | 実行ディレクトリにある、描画済みレポートのファイル名                                      |
| `improvementsFor(root, runId)`             | その実行から作った改善計画と、その適用の記録                                              |

`readArtifact` と `readLatest` に渡す成果物の名前は、`run`、`evidence`、`codeIndex`、`properties`、`testMap`、`mutation`、`claims`、`pbt`、`assessments`、`findings`、`artifactIndex` です。データには名前ごとに型が付きます（`ArtifactData<'findings'>`）。各ファイルについては[レポートと成果物](/ja/reference/reports)を参照してください。

```ts
import { buildReportInput, renderReport } from '@under18dev/veritas';

const markdown = renderReport(buildReportInput('/path/to/project'), 'markdown');
```

## 仕様

| エクスポート                                                         | 対応する CLI                         | 用途                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `listProperties(root)`                                               | `veritas spec list`                  | 承認の記録を反映した、最新の実行の Property                                                               |
| `showProperty(root, id)`                                             | `veritas spec show`                  | 1 つの Property と、その承認の記録                                                                        |
| `decideProperty(root, id, 'accept' \| 'reject', { reason, actor? })` | `veritas spec accept`、`spec reject` | `.veritas/approvals.json` に判断を追記する。判断した人は `VERITAS_ACTOR`、git の `user.name` の順に決まる |
| `diffLatest(root)`                                                   | `veritas spec diff`                  | 直近 2 回の実行の Property の差分                                                                         |

## Property-based テスト

| エクスポート                                                              | 対応する CLI            | 用途                                                                                        |
| ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `generateTests(root, { propertyId?, dryRun?, force?, allowCodeConfig? })` | `veritas test generate` | `.veritas/generated-tests/` に Vitest と fast-check のファイルを生成し、そのファイルを返す  |
| `replayPbt(root, pbtId, { runId?, signal? })`                             | `veritas test replay`   | 記録された property-based テストを再実行する。`reproduced` は記録どおりの結果が出たかを示す |
| `defaultSeed(propertyId)`                                                 | なし                    | `pbt.seed` を指定しないときに Property に使う seed                                          |

## テストの改善

| エクスポート                                                                   | 対応する CLI                | 用途                                                                                                          |
| ------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `planImprovement({ root, runId?, includeProposed?, maxIterations?, signal? })` | `veritas improve --dry-run` | テストだけを対象にした改善を計画する。`planId`、`outcome`、`plan`、`approvalToken` を含む `PlanResult` を返す |
| `applyImprovement({ root, planId, approvalToken, actor?, via?, signal? })`     | `veritas improve --apply`   | 承認された計画を隔離したコピーで適用し、`PatchAttempt` を返す。CI の中では拒否する                            |

`PlanResult.outcome` は、承認待ちの計画ができたときは `planned`、それ以外は `improved`、`no_safe_improvement`、`needs_spec_decision`、`blocked`、`error` のいずれかです。適用するものがなければ `approvalToken` は `null` です。[テストの改善](/ja/guide/improving-tests)を参照してください。

## プロジェクトの準備

| エクスポート                              | 対応する CLI     | 用途                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initProject(root, { force?, dryRun? })`  | `veritas init`   | プロジェクトを検出して `.veritas/config.json` を書く。設定と次の手順を返す                                                                                                                            |
| `loadConfig(root, { allowCodeConfig? })`  | なし             | 設定を読み込んで検証する。`{ config, file, hash }` を返す                                                                                                                                             |
| `openProject(root, { allowCodeConfig? })` | なし             | 設定を読み込む。`{ root, config, configHash }` を返す                                                                                                                                                 |
| `runDoctor(root, config, env?, bundled?)` | `veritas doctor` | ケイパビリティと機能を調べる。設定なしで調べるときは `config` に `null` を渡す。`bundled` に `bundledTools()` を渡すと、`veritas doctor` と同じく、Veritas と一緒にインストールされたツールも見つかる |
| `bundledTools()`                          | なし             | Veritas と一緒にインストールされた `@mizchi/mutator`、fast-check、`z3-solver` のバージョン（見つからないものは `null`）                                                                               |

## CLI のプログラム

`main(argv)` は、指定した引数で `veritas` コマンドを実行し、終了コードを返します。`buildProgram(setExit, writeOut?)` は、その元になる Commander のプログラムを返します。

## 型

公開している型は `Finding`、`FormalClaim`、`Mutant`、`Property`、`Run`、`TestAssessment`、`VeritasConfig`、`RunOptions`、`StageOptions`、`RunSummary`、`Profile`、`ArtifactName`、`ArtifactData`、`ReportFormat`、`Explanation`、`GeneratedTest`、`PbtReplay`、`OpenOptions`、`PlanOutcome`、`PlanResult` です。ドメインの型の JSON Schema は [`schemas/`](https://github.com/under18dev/veritas/tree/main/schemas) にあります。
