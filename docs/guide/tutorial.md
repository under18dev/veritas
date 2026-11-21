# Tutorial

In this tutorial you create a small project whose code disagrees with its README, let Veritas find the mismatch and the weak tests, decide on the specification, fix the code, and add the missing test through an approved plan.

You need Node.js 25 or later (26 recommended), npm and git. Output is trimmed where it shows `[...]`. Run IDs, plan IDs, approval IDs, approval tokens and times in your output will differ.

## Create the project

```bash
mkdir shop-pricing && cd shop-pricing
git init
```

Create the following files.

`package.json`:

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

`README.md`:

```md
# shop-pricing

Pricing rules for checkout. Amounts are integer yen.

## Discount

Orders with a total of 1000 or more receive a flat discount of 100.

## Shipping

Shipping is free for orders of 5000 or more. Otherwise shipping costs 500.
```

`src/pricing.ts`. The discount condition uses `>` where the README says "or more":

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

`test/discount-weak.test.ts`, which never tries the boundary:

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

`test/tautological.test.ts`, which never calls the code:

```ts
import { expect, it } from 'vitest';

it('pricing works', () => {
  expect(true).toBe(true);
});
```

`test/shipping-boundary.test.ts`, which checks both sides of its boundary:

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

`.gitignore`:

```text
node_modules/
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

Install the dependencies, run the tests and commit:

```bash
npm install -D vitest @under18dev/veritas
npx vitest run
git add -A && git commit -m "Add pricing rules"
```

```text
 Test Files  3 passed (3)
      Tests  5 passed (5)
```

All five tests pass, although `discountAmount(1000)` returns 0 and the README promises 100.

## 1. Create the configuration

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

## 2. Run the standard profile

The `standard` profile adds mutation testing to the static analysis: it changes the code in small ways (mutants) and runs your tests against each change.

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

explain a finding: veritas explain <finding-id>; artifacts: .veritas/runs/run-20261120T105459627Z-000-0ed704/
```

What each stage reports:

- `discover` read three sources (the README, the doc comments in `src/pricing.ts` and the git log) and found three statements in the README.
- `spec` built eight properties, all `proposed`: two from the README (`normative`) and six inferred from the code.
- `mutate` ran 17 mutants. One survived: changing `total > 1000` to `total >= 1000` makes no test fail.
- `assess` rated the two discount tests `weak_or_incomplete`, the two shipping tests `meaningful_with_evidence` and `pricing works` `tautological_or_disconnected`.

The verdict is `pass_with_warnings` (exit code `0`): there are findings to review and no confirmed specification violation yet.

- `F-0b43c88cc3a6` is `confirmed` because the mutation run showed it.
- `F-89435b62ae1e` is `suspected`: the code compares `total` with the README's number but with a different operator, and the README property is not accepted yet.
- `F-99e71509e3c4` points at the test that checks nothing.

## 3. See the evidence for a finding

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

The chain runs from the README line to the property, the tests that call `discountAmount`, their assessments and the mutants. The inputs that decide `total >= 1000` are 999 and 1000, and neither test asserts them. The last line tells you what to do next: decide whether the README rule is the specification.

## 4. List the properties

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

`normative` properties come from your documentation. `inferred` ones come from the code and only suggest what to check. `npx veritas spec show <id>` prints one property with its citation, assumptions and formal model.

## 5. Accept the discount rule

Decide that the README is the specification for the discount, and record it:

```bash
npx veritas spec accept P-ee03e6e8b749 --reason "README is the pricing specification"
```

```text
recorded accept of P-ee03e6e8b749 by you
```

The decision is appended to `.veritas/approvals.json` with your name (from `--actor`, `VERITAS_ACTOR` or `git config user.name`), the reason and the time:

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

Leave the shipping rule `proposed`. The next step shows how `--include-proposed` treats it.

## 6. Check the rules with Z3

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

`prove` asks Z3 whether any `total` in `[-10000, 10000]` violates each rule:

- For the accepted discount rule, Z3 found `total = 1000`. Veritas ran `discountAmount(1000)` in JavaScript, got the same violation, and the finding became `confirmed high`. A confirmed violation fails the default policy, so the exit code is `1`.
- The shipping rule was checked only because of `--include-proposed`. No input in the domain violates it. Because it is not accepted, the result counts as experimental.
- The shipping tests are `inconclusive` in this run because `prove` does not run mutation testing.

Run `explain` again to see the solver result:

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

The `.smt2` file is plain SMT-LIB, so any Z3 can run it again:

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

## 7. Ask for a test improvement

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

The exit code is `4`. The test Veritas would add, `discountAmount(1000)` expecting 100 from the README, fails against the current code. Veritas does not add it and does not change the expected value to 0. The outcome `needs_spec_decision` means that you have to fix either the code or the README.

## 8. Fix the code and plan again

Change `total > 1000` to `total >= 1000` in `src/pricing.ts`, then commit the fix together with the configuration and your decision:

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

The discount rule is still accepted, and the mismatch is gone. The gap remains: the mutant `total >= 1000 -> total > 1000` survives because no test uses 1000.

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

The plan adds one new test file. Its expected value, 100, comes from README line 7. The input 999 is skipped because the README states nothing about totals below 1000.

## 9. Apply the plan

Review the patch, then apply it with the plan ID and token from your own output:

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

Veritas measured the change in a temporary copy of the project and then wrote the one new file. `git status` shows `test/veritas-P-ee03e6e8b749.test.ts` as untracked. [Improving tests](/guide/improving-tests) describes each step of `--apply`.

## 10. Run the deep profile

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

- All 17 mutants are killed.
- fast-check ran the accepted rule against 1000 inputs with a recorded seed.
- Z3 found no `total` in `[-10000, 10000]` that violates the rule, and found an input at which the rule distinguishes each listed mutant from the original code.
- The new test is `meaningful_with_evidence`. The two original discount tests stay `weak_or_incomplete` because they do not check the boundary themselves.
- `pricing works` still checks nothing. Fix it or delete it yourself.

## Next

- [Reading results](/guide/reading-results) explains every status on this page.
- [Specifications](/guide/specifications) covers conflicts, rejections and `spec diff`.
- [Verification](/guide/verification) covers Z3, fast-check and Lean.
- [CI and GitHub Action](/guide/ci) runs these checks on pull requests.
