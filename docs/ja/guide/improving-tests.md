# テストの改善

`veritas improve` は、実行で見つかった穴を埋める新しいテストを提案します。テストを追加するのは、あなたがその計画をそのまま承認し、しかも結果が実際によくなったときだけです。本番のコード、既存のテスト、ドキュメントは編集しません。

## 決まりごと

- 追加するのは新しいテストファイルだけです。既存のテストを編集したり、消したり、弱めたりはしません。本番のコード、README、docs にも触れません。
- 期待値は accepted な仕様から取ります。実装を実行して得た値は使いません。`--include-proposed` を付けたときだけ、proposed な Property も使います。
- 既定の動作は計画を立てることだけで、プロジェクトのファイルは書き換えません。
- 適用には、`--apply` と、その計画と一緒に表示された計画の ID と承認トークンが必要です。
- 変更の効果は隔離したコピーで測り、結果がよくなったときだけプロジェクトに書き込みます。よくならなければ何も書き込みません。
- CI の中では適用できません。

## 1. 計画を立てる

```bash
veritas improve --dry-run
```

`--dry-run` は既定の動作なので、`veritas improve` だけでも同じです。計画は最新の実行から、または `--run <run-id>` で指定した実行から作ります。mutation testing の結果がある実行（`--profile standard` か `deep`）から作ると効果的です。結果がない場合は、境界の穴だけを対象にします。

```text
plan IP-24ed3c83a2e0 from run-20261120T104701460Z-000-7bcf92: planned

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
approval token for plan IP-24ed3c83a2e0: 1e24dc6568c711848c1115f616bbd411d9a9cfe98a34045bb2fca774f1f949f6
apply after review: veritas improve --apply --plan IP-24ed3c83a2e0 --approve 1e24dc6568c711848c1115f616bbd411d9a9cfe98a34045bb2fca774f1f949f6

plan: .veritas/improvements/IP-24ed3c83a2e0/plan.json (no project file was written)
```

計画には、目的、提案するテストと期待値の出どころ（Property と出典）、対象の穴、リスク（あれば）、予算、パッチの全文、見送った入力とその理由、承認トークンが含まれます。計画は `.veritas/improvements/<plan-id>/plan.json` に保存されます。

トークンはこの計画に結び付いています。計画が変わったり、計画が頼っている Property を計画のあとで reject したりすると、トークンは合わなくなり、計画を立て直す必要があります。

## 2. 確認して承認する

パッチのプレビューを読んでください。トークンを渡すことは、そのパッチをそのまま承認することを意味します。誰が承認したかを記録するには `--actor <name>` を付けます。付けなければ `VERITAS_ACTOR`、次に git のユーザー名を使います。

## 3. 適用する

```bash
veritas improve --apply --plan IP-24ed3c83a2e0 --approve 1e24dc6568c711848c1115f616bbd411d9a9cfe98a34045bb2fca774f1f949f6
```

```text
attempt PA-8130e27f7148 for plan IP-24ed3c83a2e0: improved
before: tests 5 passed / 0 failed, mutants 16 killed / 1 survived
after:  tests 6 passed / 0 failed, mutants 17 killed / 0 survived
note: killed mutants 16 -> 17, survived 1 -> 0
note: newly killed: M-5b67ad8e53c8
note: added: test/veritas-P-ee03e6e8b749.test.ts
note: formal and property-based results re-evaluated in run-20261120T104711023Z-000-f78024 on the patched copy
```

`--apply` の中で行われることです。

1. プロジェクトを新しい一時ディレクトリにコピーします。`node_modules` とツールの状態はコピーせず、`node_modules` はリンクして、プロジェクトの Vitest と mutator をそのまま使います。
2. パッチを当てる前のコピーで、テストと mutation testing を実行します。
3. コピーに新しいテストファイルを加え、テストと mutation testing をもう一度実行します。ここではすべての mutant を実行します。取り込んだレポート（`mutate --import`）や `--since` での絞り込みは、パッチを当てる前のコードについてのものだからです。
4. 計画の元になった実行と同じステージとオプションで、形式検証と property-based testing の結果をコピーの上でオフラインで評価し直します。
5. すべてのテスト（新しいものと、以前から通っていたもの）が通り、kill した mutant の数が増え、評価し直しも成功したときだけ、新しいファイルをプロジェクトに書き込みます。そうでなければ、その試行は取り消され、プロジェクトは変わりません。

`--max-iterations <n>`（1 から 20。既定は `improvement.maxIterations` の 3）で、一つの計画を適用しようとする回数の上限を決めます。試行は `.veritas/improvements/<plan-id>/` に `attempt-<n>.json` として、承認は `approval-<n>.json`（承認した人、日時、呼び出し元、トークンのハッシュ）として記録されます。

## 結果と終了コード

| 結果                  | 終了コード | 意味                                                                                                                |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| planned / `improved`  | `0`        | 計画ができた、または承認した計画を適用して結果がよくなった                                                          |
| `no_safe_improvement` | `4`        | 仕様から期待値を取ったテストを作れなかった、または適用したテストが失敗したか、kill した mutant が増えず、取り消した |
| `needs_spec_decision` | `4`        | 先に人が仕様を決める必要がある                                                                                      |
| `blocked`             | `1`        | パッチが安全性の検査を通らないか、計画の試行回数の上限に達した                                                      |
| トークンの誤り、CI    | `2`        | 承認トークンが違うか、CI の中で `--apply` した                                                                      |
| `error`               | `3`        | ツールが失敗した                                                                                                    |

## needs_spec_decision

計画が `needs_spec_decision` で止まるのは、次の二つの場合です。

- **対象の Property が accepted でないか、食い違っている。** `veritas spec list` で Property を確認して accept か reject をするか、proposed な Property を使ってよければ `--include-proposed` を付けて実行し直します。
- **仕様から作ったテストが、今のコードでは失敗する。** Veritas はそのテストを追加せず、通るように期待値を変えることもしません。仕様違反の候補として報告し、実装の修正案を書き出します。

```text
plan IP-0159001c54ab from run-20261120T104653570Z-000-cd8b2a: needs_spec_decision

spec violation candidates (not added; expected values unchanged):
  SVC-ec7787ca9234  discountAmount(1000) returns 0, but the specification (README.md:7) documents 100; the test is not added and its expected value is not changed
  implementation fix proposals: .veritas/improvements/IP-0159001c54ab/implementation-fix-proposal.json
```

コードか仕様のどちらかが誤っています。コードを自分で直すか、レビューを通して仕様を変えてから、計画を立て直してください。

## 拒否される場合

```text
error[IMPROVE_APPLY_IN_CI]: applying an improvement is refused in CI (improvement.autoApply is always false)
hint: run `veritas improve --apply` locally after reviewing the plan
```

環境変数 `CI` が、空、`false`、`0` 以外の値に設定されていると、`--apply` は拒否されます。計画を立てることは CI の中でもできます。

```text
error[APPROVAL_MISMATCH]: the approval token does not match plan IP-24ed3c83a2e0 (the plan changed or the token is wrong)
hint: review the plan again with `veritas improve --dry-run` and use the token it prints
```

プロジェクトの外を指すシンボリックリンクがあると、`IMPROVE_UNSAFE_LINK` で拒否されます。隔離した実行がそのリンクを通してプロジェクトの外に書き込めてしまうからです。適用する前に、リンクを実際のファイルやディレクトリに置き換えてください。

## エージェントから使う

MCP では、`plan_improvement` が計画とトークンを返し、`apply_approved_improvement` がそれを適用します。適用のツールは、サーバーを `--allow-write` 付きで起動したときだけ登録され、人が確認した計画の ID とトークンが必要です。[エージェントと MCP](/ja/guide/agents) を参照してください。
