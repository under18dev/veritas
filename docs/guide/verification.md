# Verification

Veritas checks properties against your code in three ways: Z3, fast-check and Lean 4. For each one you will find what its results cover and how to rerun a check yourself.

| Engine     | Command                                       | Result                                   | Covers                                                      |
| ---------- | --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Z3         | `veritas prove`, `veritas run --profile deep` | Claim with `smt_bounded` assurance       | Every input in the bounded domain, in an integer model      |
| fast-check | `veritas run --profile deep`                  | Property-based test with a recorded seed | The sampled inputs, run as JavaScript                       |
| Lean 4     | `veritas prove --engine lean`                 | Claim with `kernel_checked` assurance    | A kernel-checked proof about the Lean model of the function |

All three check accepted properties. Add `--include-proposed` to check proposed ones too; their results stay `suspected`.

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
- `if`/`else`, ternaries, `return`, `const`, `+ - *`, comparisons, `=== !==`, `&& || !`, and calls to other supported functions in the same file.

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

`test generate` writes fast-check tests to `.veritas/generated-tests/<property-id>.test.ts`. Each file starts with a comment stating its domains, seed and number of runs; tests for properties that are not accepted are marked `[experimental]`. Veritas does not run these files; run them with Vitest like your own tests. `--force` replaces generated files you have edited.

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

- Lean covers integer and boolean parameters; properties over records or arrays are `unsupported`.
- The Lean model is generated from the property's formal model. Its correspondence to your TypeScript code is not proven; every Lean claim lists this under its semantic gaps.
- Lean builds have a timeout and no memory limit.

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
