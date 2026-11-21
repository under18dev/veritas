# チュートリアル

コードと README が食い違っている小さなプロジェクトを作り、Veritas で食い違いと弱いテストを見つけます。そのあと仕様を決めてコードを直し、承認した計画で足りないテストを追加します。

必要なものは Node.js 25 以上（26 を推奨）、npm、git です。出力は `[...]` の箇所で省略しています。run ID、計画の ID、承認の ID、承認トークン、日時は、手元の出力では違う値になります。

## プロジェクトを作る

```bash
mkdir shop-pricing && cd shop-pricing
git init
```

次のファイルを作ります。

`package.json`：

```json
{
  "name": "shop-pricing",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  }
}
```

`README.md`：

```md
# shop-pricing

Pricing rules for checkout. Amounts are integer yen.

## Discount

Orders with a total of 1000 or more receive a flat discount of 100.

## Shipping

Shipping is free for orders of 5000 or more. Otherwise shipping costs 500.
```

`src/pricing.ts`。README は「1000 or more（1000 以上）」ですが、割引の条件は `>` になっています。

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

`test/discount-weak.test.ts`。境界の値を試していません。

```ts
import { expect, it } from 'vitest';
import { discountAmount } from '../src/pricing.js';

it('gives a discount on large orders', () => {
  expect(discountAmount(2000)).toBe(100);
});

it('gives no discount on small orders', () => {
  expect(discountAmount(10)).toBe(0);
});
```

`test/tautological.test.ts`。コードを呼んでいません。

```ts
import { expect, it } from 'vitest';

it('pricing works', () => {
  expect(true).toBe(true);
});
```

`test/shipping-boundary.test.ts`。境界の両側を確かめています。

```ts
import { expect, it } from 'vitest';
import { shippingFee } from '../src/pricing.js';

it('charges shipping just below the threshold', () => {
  expect(shippingFee(4999)).toBe(500);
});

it('ships free exactly at the threshold', () => {
  expect(shippingFee(5000)).toBe(0);
});
```

`.gitignore`：

```text
node_modules/
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

依存を入れ、テストを実行して、コミットします。

```bash
npm install -D vitest @under18dev/veritas
npx vitest run
git add -A && git commit -m "Add pricing rules"
```

```text
 Test Files  3 passed (3)
      Tests  5 passed (5)
```

`discountAmount(1000)` は 0 を返し、README は 100 と書いているのに、五つのテストはすべて通ります。

## 1. 設定ファイルを作る

```bash
npx veritas init --yes
```

```text
wrote [...]/shop-pricing/.veritas/config.json
detected: package manager=npm, tsconfig=none, vitest=5.1.1, git=true
next:
  veritas doctor
  veritas discover --offline
  veritas run --profile quick --offline
```

## 2. standard プロファイルで実行する

`standard` プロファイルは、静的解析に mutation testing を加えます。コードを少しずつ書き換えたもの（mutant）を作り、それぞれに対してテストを実行します。

```bash
npx veritas run --profile standard
```

```text
run run-20261120T105459627Z-000-0ed704  verdict: pass_with_warnings (exit 0)

succeeded   index
            2 function(s) in 1 file(s); 6 inferred candidate(s)
succeeded   discover
            3 source(s), 3 statement(s), 0 network request(s)
succeeded   spec
            properties: {"proposed":8}; 0 conflict(s)
succeeded   map
            5 test registration(s) (a loop or .each counts once), 4 symbol edge(s)
succeeded   mutate
            mutator 0.4.5: succeeded
            counts: {"killed":16,"survived":1}
            mutation.mode is "diff", but this run had no --since ref, so every mutant in scope was run; pass --since <ref> (for example --since origin/main) to mutate only the code changed since that ref
succeeded   assess
            assessments: {"weak_or_incomplete":2,"meaningful_with_evidence":2,"tautological_or_disconnected":1}; 3 finding(s)
succeeded   report
            formats: json, markdown, html, sarif

findings (3):
  F-0b43c88cc3a6  [confirmed medium] no test detects total > 1000 -> total >= 1000 at src/pricing.ts:3
  F-89435b62ae1e  [suspected medium] src/pricing.ts#discountAmount may not satisfy "total >= 1000"
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour

note: 3 finding(s) to review (not policy failures)

explain a finding: veritas explain <finding-id>; artifacts: .veritas/runs/run-20261120T105459627Z-000-0ed704/
```

各ステージの結果です。

- `discover` は三つの出典（README、`src/pricing.ts` のドキュメントコメント、git log）を読み、README から記述を三つ見つけました。
- `spec` は Property を 8 個作りました。どれも `proposed` で、README から来たもの（`normative`）が二つ、コードから推測したものが六つです。
- `mutate` は 17 個の mutant を実行しました。`total > 1000` を `total >= 1000` に変えた mutant だけが生き残り、どのテストも失敗しませんでした。
- `assess` は、割引の二つのテストを `weak_or_incomplete`、送料の二つのテストを `meaningful_with_evidence`、`pricing works` を `tautological_or_disconnected` と判定しました。

verdict は `pass_with_warnings`（終了コード `0`）です。確認すべき finding はありますが、確定した仕様違反はまだありません。

- `F-0b43c88cc3a6` は、mutation testing で確かめたので `confirmed` です。
- `F-89435b62ae1e` は `suspected` です。コードは README と同じ数で `total` を比べていますが、演算子が違います。README の Property はまだ accepted ではありません。
- `F-99e71509e3c4` は、何も確かめていないテストを指しています。

## 3. finding の根拠を見る

```bash
npx veritas explain F-89435b62ae1e
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
[...]
mutant  M-d24bb133285b [survived] src/pricing.ts:3 total > 1000 -> total >= 1000
[...]

next: review the property: veritas spec accept P-ee03e6e8b749 --reason "..." or veritas spec reject P-ee03e6e8b749 --reason "..."
```

README の行から Property、`discountAmount` を呼ぶテストとその評価、mutant までが順に並びます。`total >= 1000` の境界を決める入力は 999 と 1000 ですが、どちらのテストもこの値を assert していません。最後の行は次にすべきことで、README の規則を仕様にするかどうかを決めるよう促しています。

## 4. Property を一覧にする

```bash
npx veritas spec list
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

`normative` はドキュメントから、`inferred` はコードから来た Property です。`inferred` は確かめる対象の候補にすぎません。`npx veritas spec show <id>` で、一つの Property の出典、前提、形式モデルを確認できます。

## 5. 割引の規則を accepted にする

割引については README を仕様とする、と決めて記録します。

```bash
npx veritas spec accept P-ee03e6e8b749 --reason "README is the pricing specification"
```

```text
recorded accept of P-ee03e6e8b749 by you
```

決定は `.veritas/approvals.json` に追記されます。名前（`--actor`、`VERITAS_ACTOR`、`git config user.name` の順に使います）、理由、日時が残ります。

```json
{
  "id": "A-7d000af7e5fa",
  "propertyId": "P-ee03e6e8b749",
  "propertyVersion": 1,
  "decision": "accept",
  "actor": "you",
  "reason": "README is the pricing specification",
  "decidedAt": "2026-11-20T10:55:08.580Z",
  "sourceIds": ["src-fa35c6154f0b"]
}
```

送料の規則は `proposed` のままにします。次の手順で、`--include-proposed` を付けたときの扱いを確かめます。

## 6. Z3 で規則を検査する

```bash
npx veritas prove --include-proposed
```

```text
run run-20261120T105508829Z-000-017911  verdict: policy_failure (exit 1)
[...]
succeeded   prove
            P-ee03e6e8b749: counterexample_found {"total":"1000"}
            P-e3003339ad77: proven_within_model
succeeded   assess
            assessments: {"weak_or_incomplete":2,"inconclusive":2,"tautological_or_disconnected":1}; 2 finding(s)
[...]
findings (2):
  F-89435b62ae1e  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour

note: 1 confirmed specification violation(s)
[...]
```

`prove` は、`[-10000, 10000]` の範囲に規則を破る `total` があるかを Z3 に問います。

- accepted にした割引の規則では、Z3 が `total = 1000` を見つけました。Veritas が JavaScript で `discountAmount(1000)` を実行して同じ違反を確かめたので、finding は `confirmed high` になりました。確定した違反は既定のポリシーで失敗になり、終了コードは `1` です。
- 送料の規則は `--include-proposed` を付けたので検査され、範囲内に違反はありませんでした。accepted ではないので、この結果は実験的な扱いです。
- 送料のテストがこの実行で `inconclusive` なのは、`prove` が mutation testing を実行しないからです。

もう一度 `explain` を実行すると、ソルバーの結果が加わっています。

```bash
npx veritas explain F-89435b62ae1e
```

```text
F-89435b62ae1e [confirmed high] spec_implementation_mismatch
src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)

  documented: total >= 1000 (README.md:7)
  implementation compares the same parameter against a different boundary
  solver counterexample {"total":"1000"} reproduced in JavaScript (C-8aad536f8e71)
[...]
claim   C-8aad536f8e71 [conformance counterexample_found, none] {"total":"1000"}
        smt: .veritas/runs/run-20261120T105508829Z-000-017911/proofs/C-8aad536f8e71.smt2

next: fix the implementation or change the specification through review
next: add a test for the counterexample input
```

`.smt2` のファイルはふつうの SMT-LIB なので、どの Z3 でも実行し直せます。

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

## 7. テストの改善を計画させる

```bash
npx veritas improve --dry-run
```

```text
plan IP-c7176a11a5f3 from run-20261120T105508829Z-000-017911: needs_spec_decision

spec violation candidates (not added; expected values unchanged):
  SVC-ec7787ca9234  discountAmount(1000) returns 0, but the specification (README.md:7) documents 100; the test is not added and its expected value is not changed
  implementation fix proposals: .veritas/improvements/IP-c7176a11a5f3/implementation-fix-proposal.json
[...]
plan: .veritas/improvements/IP-c7176a11a5f3/plan.json (no project file was written)
```

終了コードは `4` です。README から期待値 100 を取った `discountAmount(1000)` のテストは、今のコードでは失敗します。Veritas はこのテストを追加せず、期待値を 0 に変えることもしません。`needs_spec_decision` は、コードと README のどちらを直すかをあなたが決める必要がある、という意味です。

## 8. コードを直して、もう一度計画する

`src/pricing.ts` の `total > 1000` を `total >= 1000` に直し、設定と決定と一緒にコミットしてから、もう一度実行します。

```bash
git add -A && git commit -m "Apply the discount at 1000"
npx veritas run --profile standard
```

```text
run run-20261120T105517747Z-000-01dbf1  verdict: pass_with_warnings (exit 0)
[...]
succeeded   spec
            properties: {"accepted":1,"proposed":7}; 0 conflict(s)
[...]
succeeded   mutate
            mutator 0.4.5: succeeded
            counts: {"killed":16,"survived":1}
[...]
findings (2):
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour
  F-e2324bef333e  [confirmed medium] no test detects total >= 1000 -> total > 1000 at src/pricing.ts:3
```

割引の規則は accepted のままで、仕様との食い違いはなくなりました。ただし、1000 を使うテストがないので、`total >= 1000 -> total > 1000` の mutant が生き残っています。

```bash
npx veritas improve --dry-run
```

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

skipped:
  M-5b67ad8e53c8: no bounded equivalence check for this mutant
  P-ee03e6e8b749 {"total":"999"}: the value for this input is only an assumption of the formal model, not stated by the source

approval token for plan IP-a14164357e16: 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b
apply after review: veritas improve --apply --plan IP-a14164357e16 --approve 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b

plan: .veritas/improvements/IP-a14164357e16/plan.json (no project file was written)
```

計画は、新しいテストファイルを一つ加えるものです。期待値の 100 は README の 7 行目から取っています。README は 1000 未満について何も書いていないので、入力 999 は見送られています。

## 9. 計画を適用する

パッチを確認したら、自分の出力に表示された計画の ID とトークンで適用します。

```bash
npx veritas improve --apply --plan IP-a14164357e16 --approve 6735e5d7e6d641b5b63f74f6521d6564c6d4821e0c2acb07a2d33b628063f67b
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

Veritas はプロジェクトの一時コピーで効果を測ってから、新しいファイルを一つだけ書き込みました。`git status` には、追跡されていないファイルとして `test/veritas-P-ee03e6e8b749.test.ts` が表示されます。`--apply` の手順は[テストの改善](/ja/guide/improving-tests)で説明しています。

## 10. deep プロファイルで実行する

```bash
npx veritas run --profile deep
```

```text
run run-20261120T105531774Z-000-7ae803  verdict: pass_with_warnings (exit 0)
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

- 17 個の mutant がすべて kill されました。
- fast-check は、記録したシードで、accepted な規則を 1000 個の入力で試しました。
- Z3 は `[-10000, 10000]` の範囲に規則を破る `total` がないことを確かめ、表示された各 mutant について、規則が元のコードと区別できる入力を見つけました。
- 新しいテストは `meaningful_with_evidence` です。もとからある割引の二つのテストは、それ自体が境界を確かめていないので `weak_or_incomplete` のままです。
- `pricing works` は何も確かめていません。直すか削除してください。

## 次に読むページ

- [結果の読み方](/ja/guide/reading-results)：このページに出てきた状態の意味。
- [仕様の確定](/ja/guide/specifications)：食い違い、reject、`spec diff`。
- [検証](/ja/guide/verification)：Z3、fast-check、Lean。
- [CI と GitHub Action](/ja/guide/ci)：プルリクエストでの実行。
