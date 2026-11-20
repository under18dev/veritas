# チュートリアル

Veritas のリポジトリにある小さなプロジェクト `fixtures/discount-boundary` で、Veritas を一通り動かします。このページの出力はすべて Veritas 0.1.1 の実際の出力で、`[...]` の箇所は省略しています。run ID と日時は、手元では違う値になります。

## 題材のプロジェクト

README には料金の規則が二つ書かれています。

```md
## Discount

Orders with a total of 1000 or more receive a flat discount of 100.

## Shipping

Shipping is free for orders of 5000 or more. Otherwise shipping costs 500.
```

実装の `src/pricing.ts` です。

```ts
/** Flat discount applied at checkout. */
export function discountAmount(total: number): number {
  if (total > 1000) {
    return 100;
  }
  return 0;
}

/** Shipping fee for an order total. */
export function shippingFee(total: number): number {
  return total >= 5000 ? 0 : 500;
}
```

README は「1000 以上（1000 or more）」、コードは `total > 1000` です。`total = 1000` のとき、README では 100 になるはずが、コードは 0 を返します。

テストファイルは三つあります。

| ファイル                         | 内容                                                                   |
| -------------------------------- | ---------------------------------------------------------------------- |
| `test/discount-weak.test.ts`     | `discountAmount(2000)` と `discountAmount(10)` を呼ぶ。1000 は試さない |
| `test/tautological.test.ts`      | `expect(true).toBe(true)` だけで、コードを呼ばない                     |
| `test/shipping-boundary.test.ts` | `shippingFee(4999)` と `shippingFee(5000)` で、境界の両側を確かめる    |

五つのテストはすべて通ります。

## コピーを用意する

リポジトリを変更しないよう、フィクスチャのコピーで作業します。Veritas のリポジトリを clone し、`pnpm install` と `pnpm build` を済ませた状態で、次を実行します。

```bash
VERITAS="$PWD"
alias veritas="node $VERITAS/packages/cli/dist/bin.js"

src="$VERITAS/fixtures/discount-boundary"
work=$(mktemp -d)
cp -R "$src/README.md" "$src/package.json" "$src/src" "$src/test" "$work/"

# インストール済みの依存を、入れ直さずにリンクします。
mkdir -p "$work/node_modules/@mizchi"
ln -s "$(realpath "$src/node_modules/vitest")" "$work/node_modules/vitest"
ln -s "$(realpath "$src/node_modules/fast-check")" "$work/node_modules/fast-check"
ln -s "$(realpath "$src/node_modules/@mizchi/mutator")" "$work/node_modules/@mizchi/mutator"

cd "$work"
printf 'node_modules\n.veritas/\n.mutator/\n' > .gitignore
git init -q && git add -A && git commit -qm "initial"
```

git リポジトリにしておくと、Veritas は実行ごとにコミットを記録し、git の履歴も出典として読みます。自分のプロジェクトでは、エイリアスの代わりに `npx veritas` を使ってください。

## 1. 設定ファイルを作る

```bash
veritas init --yes
```

```text
wrote [...]/.veritas/config.json
detected: package manager=unknown, tsconfig=none, vitest=5.1.1, git=true
next:
  veritas doctor
  veritas discover --offline
  veritas run --profile quick --offline
```

## 2. standard プロファイルで実行する

`standard` は、静的解析に mutation testing を加えます。mutant ごとにプロジェクトのテストを実行します。

```bash
veritas run --profile standard
```

```text
run run-20261120T104641575Z-000-555dcf  verdict: pass_with_warnings (exit 0)

succeeded   index
            2 function(s) in 1 file(s); 6 inferred candidate(s)
succeeded   discover
            3 source(s), 3 statement(s), 0 network request(s)
succeeded   spec
            properties: {"proposed":8}; 0 conflict(s)
succeeded   map
            5 test(s), 4 symbol edge(s)
succeeded   mutate
            mutator 0.4.5: succeeded
            counts: {"killed":16,"survived":1}
            mutation.mode is "diff" but no --since ref was given: all mutants in scope were run
succeeded   assess
            assessments: {"weak_or_incomplete":2,"meaningful_with_evidence":2,"tautological_or_disconnected":1}; 3 finding(s)
succeeded   report
            formats: json, markdown, html, sarif

findings (3):
  F-0b43c88cc3a6  [confirmed medium] no test detects total > 1000 -> total >= 1000 at src/pricing.ts:3
  F-89435b62ae1e  [suspected medium] src/pricing.ts#discountAmount may not satisfy "total >= 1000"
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour

note: 3 finding(s) to review (not policy failures)

explain a finding: veritas explain <finding-id>; artifacts: .veritas/runs/run-20261120T104641575Z-000-555dcf/
```

各ステージで起きたことです。

- `discover` は三つの出典（README、`src/pricing.ts` のドキュメントコメント、唯一のコミットのメッセージ）を読み、README から記述を三つ見つけました。
- `spec` はそれを Property にしました。8 個すべてが `proposed` で、README から来たもの（`normative`）が二つ、コードから推測したものが六つです。人が accepted にするまで、どれも仕様として扱われません。
- `mutate` は 17 個の mutant を実行し、16 個を kill しました。生き残った一つは `total > 1000` を `total >= 1000` に変えたもので、どのテストも失敗しませんでした。
- `assess` は、割引の二つのテストを `weak_or_incomplete`、送料の二つのテストを `meaningful_with_evidence`、定数を比べるテストを `tautological_or_disconnected` と判定しました。

verdict は `pass_with_warnings`、終了コードは `0` です。確認すべき finding はありますが、確定した仕様違反はまだありません。三つの finding の意味は次のとおりです。

- `F-0b43c88cc3a6` は `confirmed` です。`>=` に変えた mutant に気づくテストがないことを、実際の mutation testing で確かめたからです。
- `F-89435b62ae1e` は `suspected` です。コードは README と同じ数で `total` を比べていますが、演算子が違います。README の Property がまだ `proposed` なので、suspected より上にはなりません。
- `F-99e71509e3c4` は、何も確かめていないテストを指しています。

## 3. finding の根拠を見る

```bash
veritas explain F-89435b62ae1e
```

```text
F-89435b62ae1e [suspected medium] spec_implementation_mismatch
src/pricing.ts#discountAmount may not satisfy "total >= 1000"

  documented: total >= 1000 (README.md:7)
  implementation compares the same parameter against a different boundary
  property status is proposed; accept it to make this a confirmed violation

source  readme README.md:1  "# shop-pricing Pricing rules for checkout. Amounts are integer yen. ## Discount Orders with a total of 1000 or more rece"
quote   line 7: "Orders with a total of 1000 or more receive a flat discount of 100."
property P-ee03e6e8b749 [proposed, normative] discountAmount: total >= 1000 -> Orders with a total of 1000 or more receive a flat discount of 100.
test    test/discount-weak.test.ts:4 "gives a discount on large orders"
test    test/discount-weak.test.ts:8 "gives no discount on small orders"
assess  T-97fef42e4cf7: weak_or_incomplete - 1 specification-relevant mutant(s) it runs survived: src/pricing.ts:3 total > 1000 -> total >= 1000; boundary not exercised: total >= 1000 (decisive inputs 999, 1000; asserted: none)
assess  T-8b4efcb90022: weak_or_incomplete - 1 specification-relevant mutant(s) it runs survived: src/pricing.ts:3 total > 1000 -> total >= 1000; boundary not exercised: total >= 1000 (decisive inputs 999, 1000; asserted: none)
mutant  M-50388e69bfb9 [killed] src/pricing.ts:2 {
[...]
mutant  M-aecdf503e7bd [killed] src/pricing.ts:3 total > 1000 -> true
mutant  M-846bcbfcb4da [killed] src/pricing.ts:3 total > 1000 -> false
mutant  M-d24bb133285b [survived] src/pricing.ts:3 total > 1000 -> total >= 1000
mutant  M-78866cd5fd67 [killed] src/pricing.ts:3 total > 1000 -> total <= 1000
[...]

next: review the property: veritas spec accept P-ee03e6e8b749 --reason "..." or veritas spec reject P-ee03e6e8b749 --reason "..."
```

`explain` は、README から引用した行、Property、その関数を呼ぶテストと評価、mutant を順にたどって表示します。`total >= 1000` の境界を決める入力は 999 と 1000 ですが、どちらのテストもこの二つを assert していません。最後の行は次にすべきことで、README の規則を仕様として認めるかどうかを決めるよう促しています。

## 4. Property を確認する

```bash
veritas spec list
```

```text
P-ee03e6e8b749  proposed   normative discountAmount: total >= 1000 -> Orders with a total of 1000 or more receive a flat discount of 100.
P-e3003339ad77  proposed   normative shippingFee: total >= 5000 -> Shipping is free for orders of 5000 or more.
P-1ee7b6944b63  proposed   inferred  discountAmount: behaviour may change at total > 1000 (line 3); check total = 1000 and its neighbours
P-964a7a290508  proposed   inferred  discountAmount: behaviour for negative total (and zero)
P-b787b41cef0a  proposed   inferred  discountAmount: behaviour for non-integer, NaN, ±Infinity and unsafe-integer values of total
P-621583d37a21  proposed   inferred  shippingFee: behaviour may change at total >= 5000 (line 11); check total = 5000 and its neighbours
P-2eead7f786cb  proposed   inferred  shippingFee: behaviour for negative total (and zero)
P-d7372f0d4de0  proposed   inferred  shippingFee: behaviour for non-integer, NaN, ±Infinity and unsafe-integer values of total
```

`normative` はドキュメントから来た Property、`inferred` はコードから推測した Property です。`inferred` は何を確かめるべきかの仮説で、仕様ではありません。`veritas spec show <id>` を使うと、一つの Property の前提、出典、形式モデルを確認できます。

## 5. README の規則を accepted にする

チームで話し合い、割引については README を仕様とすることにしたとします。その決定を記録します。

```bash
veritas spec accept P-ee03e6e8b749 --reason "README is the pricing specification"
```

```text
recorded accept of P-ee03e6e8b749 by you
```

決定は `.veritas/approvals.json` に追記されます。決めた人（`--actor`、`VERITAS_ACTOR`、git のユーザー名の順に使います）、理由、日時が残ります。

```json
{
  "id": "A-aeaeacd1d243",
  "propertyId": "P-ee03e6e8b749",
  "propertyVersion": 1,
  "decision": "accept",
  "actor": "you",
  "reason": "README is the pricing specification",
  "decidedAt": "2026-11-20T10:46:53.311Z",
  "sourceIds": ["src-fa35c6154f0b"]
}
```

送料の規則は、次の手順で `--include-proposed` の働きを見るため、あえて `proposed` のままにしておきます。

## 6. 形式的に検査する

```bash
veritas prove --include-proposed
```

```text
run run-20261120T104653570Z-000-cd8b2a  verdict: policy_failure (exit 1)

[...]
succeeded   prove
            P-ee03e6e8b749: counterexample_found {"total":"1000"}
            P-e3003339ad77: proven_within_model
succeeded   assess
            assessments: {"weak_or_incomplete":2,"inconclusive":2,"tautological_or_disconnected":1}; 2 finding(s)
succeeded   report
            formats: json, markdown, html, sarif

findings (2):
  F-89435b62ae1e  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour

note: 1 confirmed specification violation(s)
[...]
```

`prove` は、形式化した Property と関数を SMT のクエリに変換し、整数の範囲 `[-10000, 10000]` で Z3 に解かせます。

- accepted にした割引の規則について、Z3 は `total = 1000` を見つけました。Veritas はこの入力を JavaScript で実行し直して同じ違反を確かめ、finding を `confirmed high` にしました。確定した仕様違反は既定のポリシーで失敗になるので、終了コードは `1` です。
- 送料の規則は、`--include-proposed` を付けたので検査されました。範囲内に違反する入力はなく、`proven_within_model` です。Property が accepted でないため、この結果は実験的な扱いです。
- 送料のテストはこの実行では `inconclusive` です。`prove` は mutation testing を実行しないので、検出力を測れていません。

`explain` には、ソルバーの結果と SMT ファイルが加わります。

```bash
veritas explain F-89435b62ae1e
```

```text
F-89435b62ae1e [confirmed high] spec_implementation_mismatch
src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)

  documented: total >= 1000 (README.md:7)
  implementation compares the same parameter against a different boundary
  solver counterexample {"total":"1000"} reproduced in JavaScript (C-8aad536f8e71)
[...]
claim   C-8aad536f8e71 [conformance counterexample_found, none] {"total":"1000"}
        smt: .veritas/runs/run-20261120T104653570Z-000-cd8b2a/proofs/C-8aad536f8e71.smt2

next: fix the implementation or change the specification through review
next: add a test for the counterexample input
```

SMT ファイルはふつうの SMT-LIB なので、どの Z3 でも実行し直せます。

```text
; veritas conformance query: is there an input in the domain that violates the property?
(set-logic ALL)
(set-option :timeout 30000)
(set-option :produce-models true)
(define-fun |discountAmount| ((|total| Int)) Int (ite (> |total| 1000) 100 0))
(declare-const |total| Int)
(assert (<= (- 10000) |total| 10000))
(assert (not (and (=> (>= |total| 1000) (= (|discountAmount| |total|) 100)) (=> (not (>= |total| 1000)) (= (|discountAmount| |total|) 0)))))
(check-sat)
(get-value (|total|))
(get-info :reason-unknown)
```

## 7. テストの改善を提案させる

```bash
veritas improve --dry-run
```

```text
plan IP-0159001c54ab from run-20261120T104653570Z-000-cd8b2a: needs_spec_decision

spec violation candidates (not added; expected values unchanged):
  SVC-ec7787ca9234  discountAmount(1000) returns 0, but the specification (README.md:7) documents 100; the test is not added and its expected value is not changed
  implementation fix proposals: .veritas/improvements/IP-0159001c54ab/implementation-fix-proposal.json

note: every targeted test fails against the implementation: the implementation or the specification needs a decision
note: run run-20261120T104653570Z-000-cd8b2a has no mutation results; only boundary gaps were considered
[...]
plan: .veritas/improvements/IP-0159001c54ab/plan.json (no project file was written)
```

終了コードは `4` です。Veritas は README から期待値 100 を取って `discountAmount(1000)` のテストを作ろうとしますが、今のコードではこのテストが失敗します。そのためテストは追加せず、通るように期待値を 0 に変えることもしません。結果は `needs_spec_decision` で、コードと README のどちらを直すかは人が決めることになります。

## 8. コードを直して、もう一度計画する

チームはコードが誤りだと判断し、`src/pricing.ts` の `total > 1000` を `total >= 1000` に直します。この変更を Veritas が行うことはなく、`implementation-fix-proposal.json` で提案するだけです。修正をコミットし、standard プロファイルで実行し直します。

```bash
git commit -qam "fix: apply the discount at 1000"
veritas run --profile standard
```

```text
run run-20261120T104701460Z-000-7bcf92  verdict: pass_with_warnings (exit 0)
[...]
succeeded   mutate
            mutator 0.4.5: succeeded
            counts: {"killed":16,"survived":1}
[...]
findings (2):
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour
  F-e2324bef333e  [confirmed medium] no test detects total >= 1000 -> total > 1000 at src/pricing.ts:3
```

コミットしても Property の ID は変わらないので、手順 5 の決定はそのまま有効です（`spec list` には `P-ee03e6e8b749  accepted` と表示されます）。仕様との食い違いはなくなりましたが、テストの穴は残っています。1000 を使うテストがまだないので、`total >= 1000 -> total > 1000` の mutant が生き残ります。

```bash
veritas improve --dry-run
```

```text
plan IP-24ed3c83a2e0 from run-20261120T104701460Z-000-7bcf92: planned

goal: Add 1 test(s) whose expected values come from the specification and at decisive boundary inputs no test checks; applying measures which mutants they kill

proposed tests (expected values from the specification):
  test/veritas-P-ee03e6e8b749.test.ts: discountAmount(1000) is 100
      property P-ee03e6e8b749 (total >= 1000): the guarding condition holds for this input, so the specification documents 100

gaps:
  F-e2324bef333e  boundary of total >= 1000: total=1000 is not checked by an asserting test
[...]
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

skipped:
  M-5b67ad8e53c8: no bounded equivalence check for this mutant
  P-ee03e6e8b749 {"total":"999"}: the value for this input is only an assumption of the formal model, not stated by the source

approval token for plan IP-24ed3c83a2e0: 1e24dc6568c711848c1115f616bbd411d9a9cfe98a34045bb2fca774f1f949f6
apply after review: veritas improve --apply --plan IP-24ed3c83a2e0 --approve 1e24dc6568c711848c1115f616bbd411d9a9cfe98a34045bb2fca774f1f949f6

plan: .veritas/improvements/IP-24ed3c83a2e0/plan.json (no project file was written)
```

計画は、新しいテストファイルを一つ追加するものです。期待値の 100 は、コードを実行して得た値ではなく、README の行から取っています。入力 999 は見送られました。README は 1000 未満の注文について何も書いていないので、そこで 0 になるというのは形式モデルの前提にすぎないからです。

## 9. 計画を適用する

計画を確認したら、計画の ID とトークンを渡して適用します。

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

Veritas はプロジェクトを一時ディレクトリにコピーし、そこにテストを加え、加える前と後でテストと mutation testing を実行しました。結果がよくなったことを確かめてから、新しいファイルをプロジェクトに書き込んでいます。結果がよくならなければ、何も書き込みません。`git status` を見ると、新しいテストファイルが一つ増えています。

## 10. deep プロファイルで実行する

```bash
veritas run --profile deep
```

```text
run run-20261120T104714190Z-000-59c0fc  verdict: pass_with_warnings (exit 0)
[...]
succeeded   mutate
            mutator 0.4.5: succeeded
            counts: {"killed":17}
[...]
succeeded   pbt
            P-ee03e6e8b749: passed
succeeded   prove
            P-ee03e6e8b749: proven_within_model
            1 formalized propert(y/ies) not verified: not accepted (use --include-proposed)
            P-ee03e6e8b749 vs mutant M-aecdf503e7bd: detects it with {"total":"-1808"}
            P-ee03e6e8b749 vs mutant M-846bcbfcb4da: detects it with {"total":"8796"}
            P-ee03e6e8b749 vs mutant M-5b67ad8e53c8: detects it with {"total":"1000"}
            P-ee03e6e8b749 vs mutant M-407cd213acfd: detects it with {"total":"4812"}
succeeded   assess
            assessments: {"weak_or_incomplete":2,"meaningful_with_evidence":3,"tautological_or_disconnected":1}; 1 finding(s)
[...]
findings (1):
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour
```

17 個の mutant がすべて kill されました。fast-check は、記録したシードで、accepted な規則を 1000 個の入力で試しました。Z3 は `[-10000, 10000]` の範囲に規則を破る入力がないことを確かめ、`property_detection` の検査は、規則が各 mutant を元のコードと区別できる入力を示しています。もとからある割引の二つのテストは、それ自体が境界を確かめていないので `weak_or_incomplete` のままで、新しいテストは `meaningful_with_evidence` です。定数を比べるテストは、直すか消すかを人が決めるために残っています。

## 次に読むページ

- [結果の読み方](/ja/guide/reading-results)：ここで出てきた状態をすべて説明しています。
- [仕様の確定](/ja/guide/specifications)：レビュー、食い違い、`spec diff` について。
- [検証](/ja/guide/verification)：Z3、fast-check、Lean の詳細。
- [テストの改善](/ja/guide/improving-tests)：計画、承認、ロールバック。
