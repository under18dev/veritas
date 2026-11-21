# テストの改善

`veritas improve` は、実行結果の穴を埋めるテストを計画します。計画は承認してから適用します。適用できないときに何が起きるかは、最後のほうの節にあります。

## `improve` が変えるもの

- 追加するのは新しいテストファイルだけです。既存のテストを編集、削除、弱めることはなく、本番のコード、README、docs にも触れません。
- 期待値は accepted な Property から取り、コードを実行して得た値は使いません。`--include-proposed` を付けると proposed な Property も使います。
- 既定の動作は計画を立てることです。計画は `.veritas/improvements/<plan-id>/plan.json` に書き出し、プロジェクトのファイルは変更しません。
- 適用には、`--apply` と、その計画で表示された計画の ID と承認トークンが必要です。
- 適用するときは、プロジェクトの一時コピーで計画の効果を測り、結果がよくなったときだけテストファイルをプロジェクトに書き込みます。
- CI の中では適用できません。

## 計画する

```bash
veritas improve --dry-run
```

オプションなしの `veritas improve` も同じ動作です。計画は最新の実行から、または `--run <run-id>` で指定した実行から作ります。`standard` か `deep` の実行のあとに計画してください。mutation testing の結果がないと、境界の穴だけが対象になります。

```text
plan IP-a14164357e16 from run-20261120T105517747Z-000-01dbf1: planned

goal: Add 1 test(s) whose expected values come from the specification and at decisive boundary inputs no test checks; applying measures which mutants they kill

proposed tests (expected values from the specification):
  test/veritas-P-ee03e6e8b749.test.ts: discountAmount(1000) is 100
      property P-ee03e6e8b749 (total >= 1000): the guarding condition holds for this input, so the specification documents 100

gaps:
  F-e2324bef333e  boundary of total >= 1000: total=1000 is not checked by an asserting test

budget: 3 iteration(s), 5 file(s), 900000 ms, 1 test retr(y/ies)

patch preview:
--- /dev/null
+++ b/test/veritas-P-ee03e6e8b749.test.ts
@@ -0,0 +1,8 @@
+// Added by `veritas improve` for property P-ee03e6e8b749.
+// Expected values come from the specification (README.md:7), not from the implementation.
+import { expect, it } from 'vitest';
+import { discountAmount } from "../src/pricing.js";
+
+it("discountAmount(1000) is 100 (boundary of the rule)", () => {
+  expect(discountAmount(1000)).toBe(100);
+});
[...]
approval token for plan IP-a14164357e16: 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b
apply after review: veritas improve --apply --plan IP-a14164357e16 --approve 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b

plan: .veritas/improvements/IP-a14164357e16/plan.json (no project file was written)
```

計画には、目的、提案するテストと期待値の出どころ（Property と出典の行）、対象の穴、予算、パッチの全文、見送った入力とその理由、承認トークンが含まれます。計画は `.veritas/improvements/<plan-id>/plan.json` に保存されます。

## 承認して適用する

パッチのプレビューを読んでください。トークンを渡すことは、そのパッチをそのまま承認することを意味します。

```bash
veritas improve --apply --plan IP-a14164357e16 --approve 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b
```

```text
attempt PA-ee6c6c6d4bc3 for plan IP-a14164357e16: improved
before: tests 5 passed / 0 failed, mutants 16 killed / 1 survived
after:  tests 6 passed / 0 failed, mutants 17 killed / 0 survived
note: killed mutants 16 -> 17, survived 1 -> 0
note: newly killed: M-5b67ad8e53c8
note: added: test/veritas-P-ee03e6e8b749.test.ts
note: formal and property-based results re-evaluated in run-20261120T105528565Z-000-2f25ef on the patched copy
```

| オプション             | 意味                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `--plan <id>`          | dry run で表示された計画の ID                                                      |
| `--approve <token>`    | dry run で表示された承認トークン                                                   |
| `--actor <name>`       | 承認した人。省略すると `VERITAS_ACTOR`、次に `git config user.name`                |
| `--run <run-id>`       | 最新ではなく、この実行から計画する                                                 |
| `--include-proposed`   | proposed な Property からも期待値を取る                                            |
| `--max-iterations <n>` | 計画を適用しようとする回数の上限。1〜20（既定は `improvement.maxIterations` の 3） |

`--apply` の中では、次の順に処理します。

1. プロジェクトを新しい一時ディレクトリにコピーします。`node_modules` とツールの状態はコピーせず、`node_modules` はリンクして、プロジェクトの Vitest と mutator を使います。
2. コピーでテストと mutation testing を実行します。
3. コピーに新しいテストファイルを加え、すべての mutant についてテストと mutation testing をもう一度実行します。
4. 計画の元になった実行と同じステージとオプションで、形式検証と property-based testing の結果をオフラインで評価し直します。
5. 次の条件をすべて満たしたときだけ、新しいファイルをプロジェクトに書き込みます。すべてのテストが通ること、kill した mutant が増えること、評価し直しがエラーなく終わること。証明と反例は、実装そのものについても mutant についても、もう一度作られて決着したままでなければなりません。例外は、パッチの前には生き残っていて、新しいテストのどれかが kill した mutant で、その結果は作られなくてもかまいません。通った property-based test は、もう一度作られた場合に決着したままでなければなりません。もともと決着していなかった結果は `unknown` や `timeout` のままでもかまいません。どれも試行の記録に残ります。条件を満たさなければコピーを捨て、プロジェクトは変わりません。

試行は `.veritas/improvements/<plan-id>/attempt-<n>.json` に、承認は `approval-<n>.json`（承認した人、日時、呼び出し元、トークンのハッシュ）に記録されます。

## 結果と終了コード

| 結果                  | 終了コード | 意味                                                                                              |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `planned`、`improved` | `0`        | 計画ができた、または適用して結果がよくなった                                                      |
| `no_safe_improvement` | `4`        | 仕様から期待値を取ったテストを作れなかった、または追加したテストが失敗したか、kill が増えなかった |
| `needs_spec_decision` | `4`        | 先に仕様を決める必要がある                                                                        |
| `blocked`             | `1`        | パッチが安全性の検査を通らない、または試行の上限に達した                                          |
| （エラー表示）        | `2`        | 承認トークンが違う、または CI の中で `--apply` した                                               |
| `error`               | `3`        | ツールが失敗した                                                                                  |

## 仕様を決める必要があるとき

次の場合、計画は `needs_spec_decision` で止まります。

- **対象の Property が accepted でない、または食い違っている。** `veritas spec` で accept か reject をするか（[仕様の確定](/ja/guide/specifications)を参照）、`--include-proposed` を付けて計画します。
- **仕様から作ったテストが、今のコードで失敗する。** Veritas は仕様違反の候補として報告し、実装の修正案を書き出し、何も追加しません。

```text
plan IP-c7176a11a5f3 from run-20261120T105508829Z-000-017911: needs_spec_decision

spec violation candidates (not added; expected values unchanged):
  SVC-ec7787ca9234  discountAmount(1000) returns 0, but the specification (README.md:7) documents 100; the test is not added and its expected value is not changed
  implementation fix proposals: .veritas/improvements/IP-c7176a11a5f3/implementation-fix-proposal.json
```

コードを直すか、仕様を変えてレビューし直してから、もう一度計画してください。

## 適用が拒否されたとき

| エラー                | 原因                                                                                      | 対処                                                         |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `APPROVAL_MISMATCH`   | トークンがその計画のものでない、または計画が変わった（使う Property を reject した など） | `veritas improve --dry-run` をやり直し、新しいトークンを使う |
| `IMPROVE_APPLY_IN_CI` | 環境変数 `CI` が、空、`false`、`0` 以外の値になっている                                   | 手元で適用する。計画は CI でも立てられる                     |
| `IMPROVE_UNSAFE_LINK` | プロジェクトの外を指すシンボリックリンクがある                                            | リンクを実際のファイルやディレクトリに置き換える             |

```text
error[IMPROVE_APPLY_IN_CI]: applying an improvement is refused in CI (improvement.autoApply is always false)
hint: run `veritas improve --apply` locally after reviewing the plan
```

エージェントからは MCP サーバーで計画と適用ができます。[エージェントと MCP](/ja/guide/agents) を参照してください。
