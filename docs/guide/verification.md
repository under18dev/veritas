# Verification

Veritas checks properties in three ways: bounded SMT queries with Z3, property-based tests with fast-check, and kernel-checked proofs with Lean 4. Each one answers a narrower question than "is the code correct", and every result says which question it answered.

| Engine     | Command                                       | Result                                   | Strength                                                |
| ---------- | --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| Z3         | `veritas prove`, `veritas run --profile deep` | Claim with `smt_bounded` assurance       | Every input in the bounded domain, in the integer model |
| fast-check | `veritas run --profile deep`                  | Property-based test with a recorded seed | The sampled inputs, run as real JavaScript              |
| Lean 4     | `veritas prove --engine lean`                 | Claim with `kernel_checked` assurance    | A kernel-checked proof about the Lean model             |

By default all three check accepted properties only. `--include-proposed` adds proposed ones; their results stay `suspected` and are marked experimental.

## Z3

`veritas prove` translates each formalized property and the functions it calls into an SMT-LIB query and asks Z3 whether any input in the domain violates it. Z3 runs from the `z3-solver` WebAssembly build in a separate process, so no separate install is needed.

```text
succeeded   prove
            P-ee03e6e8b749: counterexample_found {"total":"1000"}
            P-e3003339ad77: proven_within_model
```

### The supported subset

Formal checks cover pure functions over bounded safe integers, booleans, and simple records and arrays of them:

- parameters and results of type `number` (as integers within a bounded domain) or `boolean`;
- record parameters whose properties are all `number` or `boolean`, and arrays of numbers or booleans up to `formal.maxArrayLength` elements (default 3, at most 8);
- `if`/`else`, ternaries, `return`, `const`, `+ - *`, comparisons, `=== !==`, `&& || !`, and calls to other supported functions in the same file.

Division, `%`, `**`, floats, `NaN`, `Infinity`, `==`, `??`, implicit coercion, loops, `let`/`var`, async code, side effects and I/O are `unsupported`. The [support matrix](/concepts/support-matrix) has the full table.

The domain comes from `formal.integerDomain` (default `[-10000, 10000]`); the solver time limit from `formal.maxSolverMs` (default 30000 ms).

### Counterexamples are replayed in JavaScript

The integer model and JavaScript agree only while every value is a safe integer. Every counterexample Z3 finds is therefore run again against the real function, in a restricted Node.js process:

- If JavaScript gives the same violation, the claim is `counterexample_found`.
- If it does not, the claim is `semantic_mismatch`. The model and the code disagree, so the result is neither a bug nor a proof. Narrow `formal.integerDomain`, or rely on tests for that function.

Replay needs Node.js 25 or later (see [Getting started](/guide/getting-started#requirements)). Without it the result stays inconclusive.

Each claim writes its files to `.veritas/runs/<run-id>/proofs/`: the query (`<claim>.smt2`), the solver output (`<claim>.out`) and the replay (`<claim>.replay.json`). The query is plain SMT-LIB; you can run it with any Z3 (`z3 -smt2 proofs/<claim>.smt2`).

### Four relations

All formal claims use the same bounded query, "for all inputs within the domains, the preconditions imply the body". Their kind says what the body encodes:

| Kind                  | Question                                                                      | `counterexample_found` means                                         | `proven_within_model` means                                   |
| --------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `conformance`         | Does the implementation satisfy the property?                                 | An input where it does not, replayed in JavaScript                   | No such input within the bounds                               |
| `bounded_equivalence` | Does any input tell a surviving mutant from the original?                     | A distinguishing input; a test with it would kill the mutant         | None within the bounds: the mutant is `equivalent_proven`     |
| `distinguishability`  | Can the inputs a test already uses tell a surviving mutant from the original? | The test reaches the difference, but its assertion does not check it | None of them does: the test needs a new input                 |
| `property_detection`  | Does the property tell a mutant from the original?                            | An input where the property detects the change                       | The property cannot distinguish this mutant within the bounds |

`veritas prove` checks conformance. The other three need mutation results and run in `veritas run --profile deep`:

```text
P-ee03e6e8b749 vs mutant M-5b67ad8e53c8: detects it with {"total":"1000"}
```

Distinguishability uses only test calls whose arguments are all integer or boolean literals inside the domain. At most 40 distinguishability and property-detection checks run per run; the stage messages say how many were skipped.

## fast-check

The `pbt` stage of `veritas run --profile deep` runs each formalized property as a fast-check property against the real function, in a restricted Node.js process (Node.js 25+). Inputs come from the same subset as the formal checks: bounded integers, booleans, and records and arrays of them, plus the boundary values of the property. Strings, floats and `NaN` are never generated.

```text
succeeded   pbt
            P-ee03e6e8b749: passed
```

Each test records its seed, the number of runs and, on failure, the counterexample and the shrink path, in `pbt.json`. The number of runs is `pbt.numRuns` (default 1000); the seed is derived per property unless `pbt.seed` is set. A passing property-based test is empirical evidence about the sampled inputs, not a proof.

### Replaying a property-based test

```bash
veritas test replay PBT-ed9a14f78b2b
```

```text
PBT-ed9a14f78b2b (P-ee03e6e8b749, run run-20261120T104714190Z-000-59c0fc, seed -1082472862, 1000 runs)
recorded: passed
replayed: passed
reproduced
```

`test replay` runs the recorded test again with its seed and shrink path. It exits `0` when the recorded result is reproduced and `4` when it is not. `--run <run-id>` looks in a specific run. The ID of a failing test is in the finding's `replay:` line.

### Generating test files

```bash
veritas test generate                       # all formalized properties
veritas test generate --property <id>       # one property
veritas test generate --dry-run             # print instead of writing
```

`test generate` writes fast-check tests to `.veritas/generated-tests/<property-id>.test.ts`. Each file states its domains, seed and number of runs in a header comment; tests for properties that are not accepted are marked `[experimental]`. Veritas does not run these files. Running them with Vitest is the same as running the project's own tests. `--force` replaces generated files that were edited since they were written.

## Lean 4

```bash
veritas prove --engine lean
```

```text
succeeded   prove
            P-ee03e6e8b749 (lean): proven_within_model [kernel_checked]
```

The Lean backend generates a Lean model of the function and a theorem for the property, and builds it with `lake build`. It needs Lean 4 and Lake, installed with [elan](https://github.com/leanprover/elan); `veritas doctor` looks on `PATH` and in `~/.elan/bin`. Without them, Lean claims are `unsupported` with the reason.

A claim gets `kernel_checked` assurance only when the build succeeds and the theorem depends on no axioms beyond Lean's standard ones (`propext`, `Classical.choice`, `Quot.sound`). A proof that uses `sorry`, `admit`, `native_decide` or any other axiom is never accepted.

The Lean backend covers integer and boolean parameters only; a property over records or arrays is `unsupported` with Lean. The correspondence between the Lean model and the JavaScript code is a separate obligation, and reports list it as unmet unless it is established some other way. Lean builds have a timeout but no memory limit.

## What `proven_within_model` means

`proven_within_model` means: within the stated model, the stated domain bounds and the stated assumptions, no input violates the property. Each claim lists its scope, assumptions and semantic gaps, for example:

```text
assumptions integers are mathematical integers restricted to the stated domains; functions are pure and terminate;
the IR models the TypeScript source of each bound function; agreement is checked by replay, not proven
semantic gaps JavaScript numbers are IEEE-754 doubles; agreement with the integer model holds only while every
intermediate value is a safe integer; inputs outside the stated domains, non-integer numbers, NaN, Infinity and -0 are not covered
```

It does not mean:

- that the implementation is correct for inputs outside the domain, for floats, `NaN` or `-0`;
- that the specification itself is right (a wrong but accepted rule can be proven);
- that the tests are good (formal claims are about the code, not about the tests).

When you report a result, report it with its domain: "no counterexample for `total` in `[-10000, 10000]`", not "proven".
