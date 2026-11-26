# Verification

Veritas checks properties against your code in three ways: Z3, fast-check and Lean 4. For each one you will find what its results cover and how to rerun a check yourself.

| Engine     | Command                                       | Result                                   | Covers                                                      |
| ---------- | --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Z3         | `veritas prove`, `veritas run --profile deep` | Claim with `smt_bounded` assurance       | Every input in the bounded domain, in an integer model      |
| fast-check | `veritas run --profile deep`                  | Property-based test with a recorded seed | The sampled inputs, run as JavaScript                       |
| Lean 4     | `veritas prove --engine lean`                 | Claim with `kernel_checked` assurance    | A kernel-checked proof about the Lean model of the function |
| Z3 + Lean  | `veritas prove --engine both`                 | Both claims, Lean only where Z3 proved   | Both of the above                                           |

All of them check accepted properties. Add `--include-proposed` to check proposed ones too; their results stay `suspected`.

## Check properties with Z3

```bash
veritas prove
```

```text
succeeded   prove
            P-ee03e6e8b749: counterexample_found {"total":"1000"}
            P-e3003339ad77: proven_within_model
```

`prove` turns each property and the functions it calls into an SMT-LIB query and asks Z3 whether any input in the domain violates the property. Z3 runs from the bundled WebAssembly build in a separate process.

| Setting                 | Default           | Meaning                                              |
| ----------------------- | ----------------- | ---------------------------------------------------- |
| `formal.integerDomain`  | `[-10000, 10000]` | Range of every integer input                         |
| `formal.maxSolverMs`    | `30000`           | Time limit per query                                 |
| `formal.maxArrayLength` | `3`               | Array elements modelled per array parameter (1 to 8) |

### Supported code

Formal checks cover pure functions with:

- `number` (treated as a bounded integer) and `boolean` parameters and results;
- record parameters whose properties are all `number` or `boolean`, and `number[]` or `boolean[]` parameters up to `formal.maxArrayLength` elements;
- `if`/`else`, ternaries, `return`, `const`, `+ - *`, comparisons, `=== !==`, `&& || !`, and calls to other supported functions in the same file, which may pass on a record parameter, an object literal with exactly the callee's fields, or an array parameter.

Division, `%`, `**`, floats, `NaN`, `Infinity`, `==`, `??`, implicit coercion, loops, `let`/`var`, async code, side effects and I/O are `unsupported`. The [support matrix](/concepts/support-matrix) has the full table.

### Counterexample replay

The integer model and JavaScript agree only while every value is a safe integer. Veritas therefore runs every counterexample against your real function, in a restricted Node.js process (Node.js 25 or later):

- the same violation in JavaScript gives `counterexample_found`;
- a different result gives `semantic_mismatch`. Narrow `formal.integerDomain`, or cover that function with tests.

Without Node.js 25 or later, replay does not run and the result is inconclusive.

### Rerun a query

Each claim writes `<claim>.smt2` (the query), `<claim>.out` (solver output) and `<claim>.replay.json` (the replay) to `.veritas/runs/<run-id>/proofs/`. The query is plain SMT-LIB:

```bash
z3 -smt2 .veritas/runs/<run-id>/proofs/<claim>.smt2
```

### Relations between properties, tests and mutants

Every claim is the bounded query "for all inputs in the domains, the preconditions imply the body". Its kind says what the body encodes:

| Kind                  | Question                                                          | `counterexample_found`                                           | `proven_within_model`                                         |
| --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `conformance`         | Does the implementation satisfy the property?                     | An input where it does not, replayed in JavaScript               | No such input within the bounds                               |
| `bounded_equivalence` | Does any input distinguish a surviving mutant from the original?  | A distinguishing input; a test using it would kill the mutant    | None within the bounds: the mutant is `equivalent_proven`     |
| `distinguishability`  | Do the inputs a test already uses distinguish a surviving mutant? | Yes: the test reaches the difference but its assertion misses it | No: the test needs a new input                                |
| `property_detection`  | Does the property distinguish a mutant from the original?         | An input at which the property detects the change                | The property cannot distinguish this mutant within the bounds |

`veritas prove` checks conformance. The other three use mutation results and run in `veritas run --profile deep`:

```text
P-ee03e6e8b749 vs mutant M-5b67ad8e53c8: detects it with {"total":"1000"}
```

Distinguishability uses only test calls whose arguments are all integer or boolean literals inside the domain. Each run performs at most 40 distinguishability and property-detection checks and reports how many it skipped.

## Run property-based tests

The `pbt` stage of `veritas run --profile deep` runs each formalized property as a fast-check property against your real function, in a restricted Node.js process (Node.js 25 or later). Inputs are bounded integers, booleans, and records and arrays of them, plus the boundary values of the property. Strings, floats and `NaN` are not generated.

```text
succeeded   pbt
            P-ee03e6e8b749: passed
```

`pbt.json` records the seed, the number of runs and, on failure, the counterexample and its shrink path. `pbt.numRuns` sets the number of runs (default 1000); `pbt.seed` fixes the seed, which is otherwise derived per property. A passing test is evidence about the sampled inputs, not a proof.

### Replay a property-based test

```bash
veritas test replay PBT-ed9a14f78b2b
```

```text
PBT-ed9a14f78b2b (P-ee03e6e8b749, run run-20261120T105531774Z-000-7ae803, seed -1082472862, 1000 runs)
recorded: passed
replayed: passed
reproduced
```

`test replay` reruns the test with its recorded seed and shrink path. It exits `0` when the recorded result is reproduced and `4` when it is not. `--run <run-id>` selects the run. A failing test's ID is shown in the finding's `replay:` line.

### Generate test files

```bash
veritas test generate                   # every formalized property
veritas test generate --property <id>   # one property
veritas test generate --dry-run         # print instead of writing
```

`test generate` writes fast-check tests to `.veritas/generated-tests/<property-id>.test.ts`. Each file starts with a comment stating its domains, seed and number of runs; tests for properties that are not accepted are marked `[experimental]`. The files use the project's test runner (with the Node.js test runner they import `describe` and `it` from `node:test`). Veritas does not run these files; run them with your test runner like your own tests. `--force` replaces generated files you have edited.

## Prove properties with Lean 4

```bash
veritas prove --engine lean
```

```text
succeeded   prove
            P-ee03e6e8b749 (lean): proven_within_model [kernel_checked]
```

Veritas generates a Lean model of the function and a theorem for the property, and builds them with `lake build`. Install Lean 4 and Lake with [elan](https://github.com/leanprover/elan); `veritas doctor` looks on `PATH` and in `~/.elan/bin`. Without them, Lean claims are `unsupported`.

A claim is `kernel_checked` only when the build succeeds and the theorem depends on no axioms other than `propext`, `Classical.choice` and `Quot.sound`. A proof using `sorry`, `admit`, `native_decide` or any other axiom is rejected.

- Lean covers integer, boolean and record parameters; properties over arrays are `unsupported`.
- The Lean model is generated from the property's formal model. Its correspondence to your TypeScript code is not proven; every Lean claim lists this under its semantic gaps.
- Lean builds have a timeout and no memory limit.

To get both kinds of evidence, use `--engine both` or set `formal.backend` to `both`. Every property is checked with Z3 against your code. Lean then tries to prove the properties that Z3 proved and that it can translate, and a kernel-checked proof is added as a second claim. `both` never makes a result worse than Z3 alone:

- Lean is skipped when Z3 did not prove the property (a counterexample, a semantic mismatch, `unknown` or a timeout), since Lean would prove the same model with mathematical integers.
- Lean is skipped for properties outside its subset.
- When Lean is not installed, one message says so and only Z3 claims are recorded. A configuration with `both` can therefore be committed and used on machines and CI runners without Lean.
- When Lean cannot prove a property that Z3 proved, the stage message says so and no Lean claim is recorded; the Z3 claim stands.

Without `--engine`, `prove` uses `formal.backend`. With `formal.backend: lean`, which older versions of `veritas init` could write, `prove` now uses Lean; pass `--engine z3` for Z3 alone. Versions of Veritas before `both` was added reject a configuration that uses it.

Veritas tries a few fixed tactic scripts in turn and keeps the first proof the kernel accepts; the claim names it. When the function a property calls calls other functions, for example a decision function that maps a rule to a verdict and the verdict to an exit code, it first tries `abstract-calls-split`: it names the result of each inner call once and splits that call into its cases, instead of copying it into every place its result is used.

When the property reads more than eight booleans, splitting all of them at once gives too many cases, so Veritas first tries `name-int-calls-cases`: it names the result of every call to an integer-valued function, splits the booleans one at a time and closes each branch as soon as it is decided, and leaves the remaining integer comparisons to `omega`. Its file proves one small helper lemma before the theorem and raises Lean's elaboration budget (`maxHeartbeats`) for that theorem; the axiom check is the same as for any other proof.

## Declare a property

Rules found in documents are one source of properties. You can also write a rule yourself, as an exported function that returns `true` when the rule holds, and declare it in `.veritas/config.json`:

```ts
// src/stage.ts
export interface StageEvidence {
  failed: boolean;
  undecided: number;
  testsRan: number;
}

export function status(e: StageEvidence): number {
  if (e.failed) return 2;
  if (e.undecided > 0 || e.testsRan <= 0) return 1;
  return 0;
}

export function invariant_succeededNeedsTests(e: StageEvidence): boolean {
  return status(e) !== 0 || e.testsRan >= 1;
}
```

```json
{
  "properties": [
    {
      "id": "stage.succeeded-needs-tests",
      "kind": "holds_for_all",
      "target": "src/stage.ts#invariant_succeededNeedsTests",
      "description": "The stage succeeds only after at least one test ran.",
      "domain": { "integer": { "min": "0", "max": "1000" } }
    }
  ]
}
```

A `holds_for_all` property states that the target returns `true` for every input in the domain. The [configuration reference](/reference/configuration#declared-properties) lists every field.

| Field         | Meaning                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | A stable name. The property ID is `D-<id>`, so it does not change when you reorder or edit the declarations                                                                                |
| `target`      | `<file>#<export>`: an exported function of a file in the project, which returns `boolean` and stays in the [supported code](#supported-code). It does not have to match `analysis.include` |
| `description` | What the rule means, shown in reviews, findings and reports                                                                                                                                |
| `domain`      | Optional `integer` bounds (`min`, `max`) and `maxArrayLength`. Parts you leave out come from `formal.integerDomain` and `formal.maxArrayLength`                                            |

A declared property goes through the same review as one found in a document. It starts as `proposed`, with origin `human`, and is checked only once you accept it (or with `--include-proposed`, whose results stay `suspected`). The prove stage names every declared property it left out because it is not accepted:

```text
succeeded   prove
            D-stage.succeeded-needs-tests: declared property not verified, it is proposed (accept it with `veritas spec accept D-stage.succeeded-needs-tests --reason "<why>"`, or pass --include-proposed)
```

```bash
veritas spec accept D-stage.succeeded-needs-tests --reason "the stage rule we rely on"
veritas prove --engine both
```

```text
succeeded   prove
            D-stage.succeeded-needs-tests: proven_within_model
            D-stage.succeeded-needs-tests (lean): proven_within_model [kernel_checked]
```

You can accept a declared property before its first run, for example right after you declare it or in a fresh checkout. A declaration is fully defined by the configuration, so `veritas spec list`, `spec show`, `spec accept` and `spec reject` build it from the configuration when no run has it yet, or when the latest run checked an older version, and the decision is recorded for the version the next run gives it.

The version of a declared property is derived from its description, target, kind and domain, including the formal settings it takes its bounds from. Change any of them and the approval no longer applies: the property is `proposed` again until you accept it again. This holds in a fresh checkout and on CI too, since the version does not depend on earlier runs. The prove stage names the decision that no longer applies:

```text
D-stage.succeeded-needs-tests: the accept recorded by you (A-7d000af7e5fa) was for version 3103021279 of the declaration; it is now version 2952988804 and needs a new decision
```

A declared property that is not accepted, whether it never was or its approval went stale, is not verified, and like any other unaccepted property it does not change the exit code by itself. Where every declaration must be verified, check the run as the Veritas repository does (below).

The results mean what they mean for any other property:

- Z3 checks every input in the domain, and a counterexample is replayed against your function in JavaScript. A replay that disagrees gives `semantic_mismatch`, never a counterexample.
- A replayed counterexample to an accepted declared property is a `confirmed` `spec_implementation_mismatch` finding, which fails the run with `policy.confirmedViolation: fail`.
- With `--engine both`, Lean adds a kernel-checked proof where Z3 proved the property.
- A declaration Veritas cannot check gives an `unsupported` claim with the reason, never silence: the target file does not exist or is outside the project, the file exports no function of that name, the function returns a number, or it uses code outside the supported subset. Like any `unsupported` result it is inconclusive, so it exits `4` with `policy.inconclusiveBehavior: fail`.
- A declaration that is invalid in itself (a duplicate ID, a target without `#<export>`, `min` above `max`) fails with `CONFIG_INVALID` and exit code 2.

To check only declared properties, turn off reading documents and inferring rules from code: set `sources.local` to `false` and `analysis.inferSpecsFromCode` to `false`.

The Veritas repository checks itself this way. Its `.veritas/config.json` declares the invariants of the run policy in `packages/core/src/policy-decision.ts`, such as "the verdict is `pass` only when nothing is open" and "exit code 1 only for a policy failure", and those of the test-outcome rules in `packages/assessment/src/decision.ts`, such as "`meaningful_with_evidence` only with the full evidence" and "a test expected to fail is always `inconclusive`". A maintainer reviews each declaration and records the decision with `veritas spec accept`, which writes `.veritas/approvals.json`; that file is committed next to the configuration. `node scripts/check-self-verification.mjs` (after `pnpm build` and `veritas prove --engine both`) fails unless every declared property is accepted, proven by Z3 with a confirmed replay, and kernel-checked by Lean, in the newest run, and that run is of the current checkout: the same configuration and sources (the analyzed files and every declared target file), the same commit when the tree is clean, and the current version of every declaration. A run that did not record its claims fails too. `fixtures/declared-properties` keeps a negative control, a deliberately false invariant that must come back with a counterexample (`--expect-counterexample`). The proof covers the decision rules only: how Veritas counts the evidence it passes to them is checked by tests, not proven. CI runs all of this on every change; see [CI](/guide/ci#verify-declared-properties-in-ci).

## What `proven_within_model` means

It means that no input violates the property within the stated model, domain and assumptions. Every claim lists them, for example:

```text
assumptions integers are mathematical integers restricted to the stated domains; functions are pure and terminate;
the IR models the TypeScript source of each bound function; agreement is checked by replay, not proven
semantic gaps JavaScript numbers are IEEE-754 doubles; agreement with the integer model holds only while every
intermediate value is a safe integer; inputs outside the stated domains, non-integer numbers, NaN, Infinity and -0 are not covered
```

It does not mean that:

- the code is correct outside the domain, or for floats, `NaN` or `-0`;
- the specification is right (an accepted but wrong rule can be proven);
- your tests are good (claims are about the code, not the tests).

Report it with its domain, for example "no counterexample for `total` in `[-10000, 10000]`".
