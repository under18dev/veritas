# Improving tests

`veritas improve` proposes new tests for the gaps a run found, and adds them only after you approve the exact plan and only if they measurably help. It never edits production code, existing tests or documentation.

## The rules

- Only new test files are added. Existing tests are never edited, deleted or weakened; production code, README and docs are never touched.
- Expected values come from accepted specifications, never from running the implementation. `--include-proposed` explicitly allows proposed properties as well.
- Planning is the default and writes no project file.
- Applying needs `--apply`, the plan ID and the approval token printed with that plan.
- The change is measured in an isolated copy and written to the project only if the results improve. Otherwise nothing is written.
- Applying is refused in CI.

## 1. Plan

```bash
veritas improve --dry-run
```

`--dry-run` is the default; `veritas improve` alone does the same. The plan is built from the latest run, or from `--run <run-id>`. It is most useful after a run with mutation results (`--profile standard` or `deep`); without them, only boundary gaps are considered.

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

The plan lists the goal, each proposed test with the property and source its expected value comes from, the gaps it addresses, any risks, the budget, the full patch, the inputs it skipped and why, and the approval token. It is saved in `.veritas/improvements/<plan-id>/plan.json`.

The token is bound to this plan. If the plan changes, or a property it relies on is rejected after planning, the token no longer matches and the plan has to be made again.

## 2. Review and approve

Read the patch preview. The token is your approval of exactly that patch. Pass `--actor <name>` to record who approved it; otherwise `VERITAS_ACTOR`, then the git user name is used.

## 3. Apply

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

What happens during `--apply`:

1. The project is copied to a fresh temporary directory, without `node_modules` and tool state; `node_modules` is linked so the project's own Vitest and mutator are used.
2. The tests and mutation testing run on the copy before the patch.
3. The new test files are added to the copy, and the tests and mutation testing run again. Mutation testing always runs every mutant here: an imported report (`mutate --import`) or a `--since` selection describes the code before the patch.
4. The formal and property-based results are re-evaluated on the copy with the stages and options of the run the plan came from, offline.
5. The new files are written to the project only if every test passes (the new ones and all that passed before), the number of killed mutants increases and the re-evaluation succeeds. Otherwise the attempt is rolled back and the project stays unchanged.

`--max-iterations <n>` (1 to 20, default from `improvement.maxIterations`, 3) limits the apply attempts for a plan. Each attempt is recorded in `.veritas/improvements/<plan-id>/` as `attempt-<n>.json`, and each approval as `approval-<n>.json` (approver, time, entry point, token hash).

## Outcomes and exit codes

| Outcome               | Exit code | Meaning                                                                                                                                             |
| --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| planned / `improved`  | `0`       | A plan is ready, or an approved plan was applied and improved the results                                                                           |
| `no_safe_improvement` | `4`       | No test with a specification-derived expected value could be built, or the applied tests failed or killed no additional mutant and were rolled back |
| `needs_spec_decision` | `4`       | A person has to decide on the specification first                                                                                                   |
| `blocked`             | `1`       | The patch fails the safety checks, or the plan's attempt budget is used up                                                                          |
| bad token, CI         | `2`       | Wrong approval token, or `--apply` in CI                                                                                                            |
| `error`               | `3`       | A tool failed                                                                                                                                       |

## needs_spec_decision

A plan stops with `needs_spec_decision` in two situations:

- **The targeted properties are not accepted, or are in conflict.** Review the properties (`veritas spec list`) and accept or reject them, or rerun with `--include-proposed` if you want proposed properties used.
- **A test built from the specification fails against the code.** Veritas does not add it and does not change its expected value to make it pass. It reports a specification violation candidate and writes an implementation fix proposal:

```text
plan IP-0159001c54ab from run-20261120T104653570Z-000-cd8b2a: needs_spec_decision

spec violation candidates (not added; expected values unchanged):
  SVC-ec7787ca9234  discountAmount(1000) returns 0, but the specification (README.md:7) documents 100; the test is not added and its expected value is not changed
  implementation fix proposals: .veritas/improvements/IP-0159001c54ab/implementation-fix-proposal.json
```

Either the code or the specification is wrong. Fix the code yourself, or change the specification through review, then plan again.

## Refusals

```text
error[IMPROVE_APPLY_IN_CI]: applying an improvement is refused in CI (improvement.autoApply is always false)
hint: run `veritas improve --apply` locally after reviewing the plan
```

`--apply` is refused whenever the `CI` environment variable is set to anything other than an empty value, `false` or `0`. Planning still works in CI.

```text
error[APPROVAL_MISMATCH]: the approval token does not match plan IP-24ed3c83a2e0 (the plan changed or the token is wrong)
hint: review the plan again with `veritas improve --dry-run` and use the token it prints
```

A project that contains symbolic links pointing outside the project is refused with `IMPROVE_UNSAFE_LINK`, because the isolated run could write through them. Replace those links with real files or directories before applying.

## From an agent

Through MCP, `plan_improvement` returns the plan and the token, and `apply_approved_improvement` applies it. The apply tool exists only when the server is started with `--allow-write`, and it needs the plan ID and token a person reviewed. See [Agents and MCP](/guide/agents).
