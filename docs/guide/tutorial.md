# Tutorial

This walk-through runs Veritas on `fixtures/discount-boundary`, a small project in the Veritas repository. All output on this page is real output of Veritas 0.1.1, trimmed where marked with `[...]`. Your run IDs and timestamps will differ.

## The project

The README states two pricing rules:

```md
## Discount

Orders with a total of 1000 or more receive a flat discount of 100.

## Shipping

Shipping is free for orders of 5000 or more. Otherwise shipping costs 500.
```

The implementation, `src/pricing.ts`:

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

The README says "1000 or more"; the code says `total > 1000`. At `total = 1000` the README expects 100 and the code returns 0.

There are three test files:

| File                             | What it does                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `test/discount-weak.test.ts`     | Calls `discountAmount(2000)` and `discountAmount(10)`; never tries 1000        |
| `test/tautological.test.ts`      | `expect(true).toBe(true)`; never calls the code                                |
| `test/shipping-boundary.test.ts` | Checks `shippingFee(4999)` and `shippingFee(5000)`, both sides of the boundary |

All five tests pass.

## Set up a copy

Work on a copy of the fixture so the repository stays unchanged. In a clone of the Veritas repository, after `pnpm install` and `pnpm build`:

```bash
VERITAS="$PWD"
alias veritas="node $VERITAS/packages/cli/dist/bin.js"

src="$VERITAS/fixtures/discount-boundary"
work=$(mktemp -d)
cp -R "$src/README.md" "$src/package.json" "$src/src" "$src/test" "$work/"

# Link the fixture's installed dependencies instead of installing them again.
mkdir -p "$work/node_modules/@mizchi"
ln -s "$(realpath "$src/node_modules/vitest")" "$work/node_modules/vitest"
ln -s "$(realpath "$src/node_modules/fast-check")" "$work/node_modules/fast-check"
ln -s "$(realpath "$src/node_modules/@mizchi/mutator")" "$work/node_modules/@mizchi/mutator"

cd "$work"
printf 'node_modules\n.veritas/\n.mutator/\n' > .gitignore
git init -q && git add -A && git commit -qm "initial"
```

The git repository gives Veritas a commit to record in each run and the git history as an evidence source. In your own project, use `npx veritas` instead of the alias.

## 1. Create the configuration

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

## 2. Run the standard profile

`standard` adds mutation testing to the static analysis. It runs the project's tests, once per mutant.

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

What happened:

- `discover` read three sources (the README, the doc comments in `src/pricing.ts`, and the message of the project's one commit) and found three statements in the README.
- `spec` turned them into properties. All eight are `proposed`: two from the README (`normative`) and six inferred from the code. Nothing is accepted until a person accepts it.
- `mutate` ran 17 mutants. 16 were killed. One survived: changing `total > 1000` to `total >= 1000` breaks no test.
- `assess` rated the two discount tests `weak_or_incomplete`, the two shipping tests `meaningful_with_evidence` and the constant assertion `tautological_or_disconnected`.

The verdict is `pass_with_warnings` with exit code `0`: there are findings to review, but none is a confirmed specification violation yet. The three findings say:

- `F-0b43c88cc3a6` is `confirmed`, because a real mutation run showed it: no test notices the `>=` mutant.
- `F-89435b62ae1e` is `suspected`. The code compares `total` against the same number as the README but with a different operator. Because the README property is only `proposed`, this cannot be more than suspected.
- `F-99e71509e3c4` flags the test that checks nothing.

## 3. Explain a finding

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

`explain` follows the chain from the quoted README line to the property, the tests that reach the function, their assessments and the mutants. The decisive inputs for `total >= 1000` are 999 and 1000, and neither test asserts either of them. The last line says what to do next: decide whether the README rule is the specification.

## 4. Review the properties

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

`normative` properties come from documentation; `inferred` ones come from the code and are hypotheses about what to check, not specifications. `veritas spec show <id>` prints one property with its assumptions, citation and formal model.

## 5. Accept the README rule

Suppose the team agrees that the README is the specification for the discount. Record that decision:

```bash
veritas spec accept P-ee03e6e8b749 --reason "README is the pricing specification"
```

```text
recorded accept of P-ee03e6e8b749 by you
```

The decision is appended to `.veritas/approvals.json` with the actor (from `--actor`, `VERITAS_ACTOR` or the git user name), the reason and the time:

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

The shipping rule is left `proposed` on purpose, to show what `--include-proposed` does in the next step.

## 6. Check the properties formally

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

`prove` translates each formalized property and the function into an SMT query and runs Z3 over the integer domain `[-10000, 10000]`:

- For the accepted discount rule, Z3 found `total = 1000`. Veritas replayed that input in JavaScript, got the same violation, and the finding became `confirmed high`. A confirmed specification violation fails the default policy, so the exit code is `1`.
- The shipping rule is checked only because of `--include-proposed`. Z3 found no violating input within the domain: `proven_within_model`. Since the property is not accepted, this result is experimental.
- The shipping tests are `inconclusive` in this run: `prove` does not run mutation testing, so their detection power was not measured in it.

`explain` now shows the solver claim and the SMT file:

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

The SMT file is plain SMT-LIB and can be re-run with any Z3:

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

## 7. Ask for test improvements

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

Exit code `4`. Veritas would write a test `discountAmount(1000)` expecting 100, taken from the README. That test fails against the current code, so Veritas does not add it, and it does not change the expected value to 0 to make it pass. The outcome is `needs_spec_decision`: either the code or the README has to change, and that is a decision for a person.

## 8. Fix the code and plan again

The team decides the code is wrong and changes `total > 1000` to `total >= 1000` in `src/pricing.ts`. Veritas never makes this change; it only proposes it in `implementation-fix-proposal.json`. Commit the fix and run the standard profile again:

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

The property keeps its ID across the commit, so the decision from step 5 still applies (`spec list` shows `P-ee03e6e8b749  accepted`). The mismatch is gone, but the gap remains: the mutant `total >= 1000 -> total > 1000` survives, because still no test uses 1000.

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

The plan adds one new test file. Its expected value, 100, comes from the README line, not from running the code. The input 999 is skipped: the README says nothing about orders below 1000, so the value 0 there is only an assumption of the formal model.

## 9. Apply the plan

After reviewing the plan, apply it with the plan ID and the token:

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

Veritas copied the project to a temporary directory, added the test there, ran the tests and mutation testing before and after, and only then wrote the new file into the project. Had the mutation results not improved, nothing would have been written. `git status` now shows one new test file.

## 10. Run the deep profile

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

All 17 mutants are killed. fast-check ran 1000 inputs against the accepted rule with a recorded seed. Z3 found no input in `[-10000, 10000]` that violates it, and the `property_detection` checks show inputs at which the rule tells each mutant from the original. The two original discount tests are still `weak_or_incomplete`, because they themselves do not check the boundary; the new test is `meaningful_with_evidence`. The tautological test remains for a person to fix or remove.

## What to read next

- [Reading results](/guide/reading-results) explains every status you saw above.
- [Specifications](/guide/specifications) covers review, conflicts and `spec diff`.
- [Verification](/guide/verification) covers Z3, fast-check and Lean in detail.
- [Improving tests](/guide/improving-tests) covers plans, approvals and rollback.
