# Improving tests

`veritas improve` plans new tests for the gaps a run found. You approve a plan before it is applied, and the last sections cover what happens when a plan cannot be applied.

## What `improve` changes

- It adds new test files only. It never edits, deletes or weakens existing tests, and never touches production code, README or docs.
- Expected values come from accepted properties, never from running your code. `--include-proposed` also allows proposed properties.
- Planning is the default. It writes the plan to `.veritas/improvements/<plan-id>/plan.json` and changes no file of your project.
- Applying needs `--apply` with the plan ID and approval token printed for that plan.
- Applying measures the plan in a temporary copy of the project and writes the test files into your project only when the results improve.
- Applying is refused in CI.

## Plan

```bash
veritas improve --dry-run
```

`veritas improve` without options does the same. The plan is built from the latest run, or from `--run <run-id>`. Plan after a `standard` or `deep` run: without mutation results, only boundary gaps are considered.

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

The plan shows the goal, each proposed test with the property and source line its expected value comes from, the gaps it addresses, the budget, the full patch, the inputs it skipped with the reason, and the approval token. It is saved as `.veritas/improvements/<plan-id>/plan.json`.

## Approve and apply

Read the patch preview. Passing the token approves exactly that patch.

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

| Option                 | Meaning                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `--plan <id>`          | The plan ID from the dry run                                                          |
| `--approve <token>`    | The approval token from the dry run                                                   |
| `--actor <name>`       | Who approves. Default: `VERITAS_ACTOR`, then `git config user.name`                   |
| `--run <run-id>`       | Plan from this run instead of the latest one                                          |
| `--include-proposed`   | Also take expected values from proposed properties                                    |
| `--max-iterations <n>` | Apply attempts allowed for the plan, 1 to 20 (default `improvement.maxIterations`, 3) |

During `--apply`, Veritas:

1. copies the project to a new temporary directory, without `node_modules` and tool state, and links `node_modules` so your test runner and mutator are used;
2. records the files of the copy and the metadata of the installed dependencies the copy links to (see [Checks on the copy](#checks-on-the-copy));
3. runs the tests and mutation testing on the copy, and checks that they left the copy as it was;
4. adds the new test files to the copy and runs the tests and mutation testing again, on every mutant;
5. re-evaluates the formal and property-based results on the copy with the stages and options of the run the plan came from, offline;
6. writes the new files into the project only if the copy differs from what was copied by the new files alone, with exactly the planned content, the installed dependencies are unchanged, every test passes, more mutants are killed, at least one of the new tests kills a mutant that survived before the patch, both mutation runs are complete (mutator's time budget did not run out and no source file was left out), and the re-evaluation completes without an error. Every proof or counterexample, whether about the implementation itself or about a mutant, must be produced again and stay decided. The one exception is a mutant that survived before the patch and that one of the new tests kills: its results may be absent. A passed property-based test must stay decided when it is produced again, and results that were already undecided may stay `unknown` or `timeout`; the attempt records them. Otherwise it discards the copy and your project is unchanged.

### Checks on the copy

The new tests are code. Once you approve a plan, they run with your user's privileges, like any other test in your project, and they can write files. Veritas checks two things around the runs:

- **The copy itself.** The baseline runs must leave every file of the copy as it was copied, both its content and its metadata. After the patched runs, the only allowed difference is the new test files, with exactly the planned content. Any other file created, changed or deleted, including a file rewritten and then restored and a new `__snapshots__` file, makes the attempt `no_safe_improvement`. The attempt lists the files, and nothing is written to your project. So a test cannot fake its result by editing the code or the other tests it is measured against. `.veritas/`, `.mutator/` and `node_modules/` in the copy hold tool output and caches, and are not compared.
- **Installed dependencies.** The copy links each installed package to its real location instead of copying `node_modules`. A test running in the copy can therefore write into your project's real dependencies, including a pnpm or bun store and workspace packages linked from elsewhere. Before the first run, Veritas records the size, times, inode and link target of every entry in those trees. It compares them again after the last run and before writing anything. Any difference makes the attempt `error` and lists the changed paths, and nothing is written. Veritas cannot undo such a change: remove `node_modules` and reinstall from the lockfile before you run your tests again. Change times are part of the comparison because a program cannot set them back. Only metadata is read, which takes well under a second for tens of thousands of files.

These checks detect writes after the fact; they do not prevent them. Copying `node_modules` for every attempt would be slow for large dependency trees, and a pnpm or bun layout copied as it is still links into the shared store, so the dependencies stay shared. The checks are a safety net, not a security boundary. A new test can still write anywhere else your user can write, by absolute path, read your files, use the network, and forge what its own test runner reports. Apply plans only to code you trust, and run Veritas in a container for code you do not (see [Untrusted repositories](/guide/untrusted-repositories)).

Each attempt is recorded as `.veritas/improvements/<plan-id>/attempt-<n>.json`, and each approval as `approval-<n>.json` with the approver, time, entry point and a hash of the token.

## Outcomes and exit codes

| Outcome               | Exit code | Meaning                                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned`, `improved` | `0`       | A plan is ready, or an applied plan improved the results                                                                                                                                                                                                                                                                          |
| `no_safe_improvement` | `4`       | No test with a specification-derived expected value could be built; the applied tests failed or no new test killed an additional mutant; a mutation run was incomplete (its time budget ran out or a file was left out), so before and after cannot be compared; or a run changed files of the copy other than the new test files |
| `needs_spec_decision` | `4`       | You must decide on the specification first                                                                                                                                                                                                                                                                                        |
| `blocked`             | `1`       | The patch fails the safety checks, or the plan's attempts are used up                                                                                                                                                                                                                                                             |
| (error message)       | `2`       | Wrong approval token, or `--apply` in CI                                                                                                                                                                                                                                                                                          |
| `error`               | `3`       | A tool failed, or a run in the copy changed the installed dependencies                                                                                                                                                                                                                                                            |

## When a decision is needed

A plan stops with `needs_spec_decision` when:

- **The targeted properties are not accepted, or conflict.** Accept or reject them with `veritas spec` (see [Specifications](/guide/specifications)), or plan with `--include-proposed`.
- **A test built from the specification fails against your code.** Veritas reports it as a specification violation candidate, writes an implementation fix proposal, and adds nothing:

```text
plan IP-c7176a11a5f3 from run-20261120T105508829Z-000-017911: needs_spec_decision

spec violation candidates (not added; expected values unchanged):
  SVC-ec7787ca9234  discountAmount(1000) returns 0, but the specification (README.md:7) documents 100; the test is not added and its expected value is not changed
  implementation fix proposals: .veritas/improvements/IP-c7176a11a5f3/implementation-fix-proposal.json
```

Fix the code, or change the specification and review it again, then plan again.

## When applying is refused

| Error                 | Cause                                                                                                     | What to do                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `APPROVAL_MISMATCH`   | The token does not belong to the plan, or the plan changed (for example, a property it uses was rejected) | Run `veritas improve --dry-run` again and use the new token |
| `IMPROVE_APPLY_IN_CI` | The `CI` environment variable is set to a value other than empty, `false` or `0`                          | Apply locally; planning works in CI                         |
| `IMPROVE_UNSAFE_LINK` | The project contains symbolic links that point outside it                                                 | Replace those links with real files or directories          |

```text
error[IMPROVE_APPLY_IN_CI]: applying an improvement is refused in CI (improvement.autoApply is always false)
hint: run `veritas improve --apply` locally after reviewing the plan
```

Agents can plan and apply through the MCP server; see [Agents and MCP](/guide/agents).
