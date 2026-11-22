# Semantics

Every result Veritas reports has a precise, limited meaning. For each status you will find what it means, under which model and bounds it holds, and what it must not be read as. The vocabularies are fixed: no other status is ever reported, and none of them is collapsed into a single quality or confidence score.

## Status vocabularies

| Subject                | Statuses                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verification (claim)   | `proven_within_model`, `counterexample_found`, `unknown`, `unsupported`, `timeout`, `semantic_mismatch`, `error`                                               |
| Specification (review) | `proposed`, `reviewed`, `accepted`, `rejected`, `conflicted`, `superseded`                                                                                     |
| Test outcome           | `meaningful_with_evidence`, `weak_or_incomplete`, `tautological_or_disconnected`, `spec_conflict`, `inconclusive`                                              |
| Mutant                 | `killed`, `survived`, `timeout`, `compile_error`, `runtime_error`, `ignored`, `no_coverage`, `pending`, `unknown`, `suspected_equivalent`, `equivalent_proven` |
| Finding certainty      | `confirmed`, `suspected`, `informational`                                                                                                                      |

## What a status means

| Status                 | Meaning                                                                                                            | Not to be read as                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `proven_within_model`  | The solver found no counterexample for the stated property, within the stated model, domain bounds and assumptions | The implementation is correct; the specification is correct |
| `counterexample_found` | The solver produced an assignment violating the property, and re-running it in JavaScript gave the same verdict    | A confirmed bug in the specification's intent               |
| `semantic_mismatch`    | The solver's counterexample does not reproduce in JavaScript; the model and the code disagree                      | Either a bug or a proof                                     |
| `unknown`, `timeout`   | The solver gave no answer, or the model could not be compared with the JavaScript code                             | Success                                                     |
| `unsupported`          | The code or property is outside the supported subset                                                               | Success                                                     |
| `error`                | The tool failed                                                                                                    | Success                                                     |

Lean results carry `kernel_checked` assurance only when the proof uses no `sorry`, `admit`, `native_decide` or axioms beyond Lean's standard ones ([ADR 0005](/adr/0005-lean-backend)); a proof that uses any of them is never treated as verified. SMT results carry `smt_bounded` assurance. Reports show the difference.

A run fails the policy (exit code 1) only through a confirmed specification violation or a missed policy threshold; suspected findings never fail it (see [CLI exit codes](/reference/cli#exit-codes)). `unknown`, `timeout` and `unsupported` are never counted as success. Under `policy.inconclusiveBehavior: warn` they leave the exit code at 0 but keep the verdict at `pass_with_warnings`, never `pass`.

## What is checked

Every formal claim is the same bounded query, "for all inputs within the domains, the preconditions imply the body"; its kind says which relation the body encodes. `veritas prove` checks conformance; the others need mutation results (`veritas run --profile deep`).

| Kind                  | Question                                                                      | `counterexample_found`                                                                                      | `proven_within_model`                                                        |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `conformance`         | Does the implementation satisfy the property?                                 | An input where it does not, replayed in JavaScript                                                          | No such input within the bounds                                              |
| `bounded_equivalence` | Does any input tell a surviving mutant from the original?                     | A distinguishing input (a test with it and the specified result would kill the mutant)                      | None within the bounds: the mutant is `equivalent_proven`                    |
| `distinguishability`  | Can the inputs a test already uses tell a surviving mutant from the original? | One of the test's inputs does: the test reaches the difference but its assertion does not check it          | None of them does: the test needs a new input                                |
| `property_detection`  | Does the property tell a mutant from the original?                            | An input where the original satisfies the property and the mutant does not: the property detects the change | No such input within the bounds: the property cannot distinguish this mutant |

Distinguishability uses only calls whose arguments are all integer or boolean literals inside the domain; a test with other arguments gets no claim. In the three mutant relations the mutant exists only as a model of the mutated source: the original side is replayed in JavaScript, the mutant side is not. At most 40 distinguishability and property-detection checks run per run; the stage messages say how many were skipped. Undecided results (`unknown`, `timeout`) leave the stage partial, as for conformance.

## Supported formal subset

- Pure functions with no side effects, I/O, async, `this`, closures over mutable state, `eval` or `Proxy`.
- Parameters and results that are booleans or integers. Integer parameters must have an explicit bounded domain inside the safe-integer range (default `[-10000, 10000]`).
- Parameters that are records of integer and boolean properties, or arrays of integers or booleans with at most `formal.maxArrayLength` (default 3, at most 8) elements. Results stay integers or booleans.
- Comparison, integer `+ - *`, logical operators, `if`/`else`, ternaries and conditional `return`.

## Records and arrays

Records and arrays are flattened into scalar model parameters: the field `order.total` becomes `order__total`, and an array `xs` becomes a length `xs__length` in `[0, maxArrayLength]` plus one parameter per element slot (`xs__0`, `xs__1`, ...). Slots at or beyond the length are not part of the JavaScript value. Counterexamples are shown, and replayed in JavaScript, in the shape of the original arguments (`{"order":{"total":"1000","vip":false}}`, `{"xs":["7"]}`).

A call to another function in the same file can pass a record or an array on. A record argument must be a record parameter with exactly the callee's fields and field types (the declared type names may differ), or an object literal that lists each of the callee's fields once (`g({ total: order.total, vip: true })`, or the shorthand `g({ total, vip })`). An array argument must be an array parameter with the same element type. The argument becomes the callee's flattened parameters, in the order the callee declares its fields. The subset has no assignment, so passing a record by reference cannot change what the callee reads. Optional or nested fields, missing or extra fields, spreads, computed keys, methods, array literals and any other expression as a record or array argument are `unsupported`, with the reason. Out-of-bounds reads inside the callee count as reads of the caller, under the condition the call is made.

Reading `xs[k]` when `k >= xs.length` gives `undefined` in JavaScript, which the model does not describe. Every element read records the condition under which it is out of bounds (taking `if`, ternary, `&&` and `||` guards into account), and a property is only `proven_within_model` when the solver shows that no input in the domain satisfying the preconditions can reach such a read. Otherwise the claim is `unsupported`, with an input that reads beyond the length; an undecided check gives `unknown`. Arrays longer than `maxArrayLength` are not covered.

## JavaScript numbers versus the integer model

The model uses mathematical integers. JavaScript uses IEEE-754 doubles. They agree only for safe integers when no intermediate result leaves the safe range and no division or fractional value appears. Veritas therefore:

- restricts domains to safe integers and checks intermediate bounds;
- treats `/`, `%` on possibly negative operands, `Math.*`, `NaN`, `Infinity`, `-0`, floats, `BigInt` mixing and implicit coercion as `unsupported`;
- re-executes every counterexample in JavaScript and reports `semantic_mismatch` if the verdict differs.

## Mutants

- `killed`: at least one test failed under the mutant.
- `survived`: tests ran the mutant and none failed. This is a test gap candidate, not a bug.
- `suspected_equivalent`: no difference observed; equivalence not shown.
- `equivalent_proven`: no input in the stated bounded domain distinguishes it (a `bounded_equivalence` claim); the bounds are part of the result.
- `timeout`: the test run did not finish under the mutant (usually a mutated loop). Counted as detected, as in other mutation tools, but never credited to a specific test as a kill. Each test that covers a specification-relevant timeout mutant lists it under unknowns.
- `pending`, `unknown`: the mutant was not run, or the backend reported a status Veritas does not recognize. An `unknown` mutant makes the mutation stage `partial`, so the run cannot `pass`; so does a `pending` one, except in an incremental run (`--since`), where mutants outside the change are left out on purpose. When mutator's time budget runs out, the mutants it did not run are `pending` too, and the stage is `partial` even with `--since`.

Mutator runs only the test files that could kill the mutants in scope. A test file is left out only when it imports project sources and none of them is in scope. Files are always kept when they, or a local file they import, run code in a child process, load modules at run time (dynamic `import()`, `require`, `createRequire`) or import a relative module that does not resolve. Files in which no test was recognized are also kept. Code that reaches the project only through Vitest configuration (`globalSetup`, plugins) is not seen; if your tests depend on it, set the scope so that those test files import a source in scope.

## Specifications

- Properties start as `proposed`. Only an explicit approval record makes one `accepted`.
- Properties inferred from code, tests or runtime observation (origin `inferred` or `observed`) are never independent evidence for themselves. With `analysis.inferSpecsFromCode: false`, code-inferred candidates are not proposed at all.
- Conflicting sources produce `conflicted`; Veritas proposes a preferred reading with both sources but does not pick one, and never merges them into one property.
- Specifications and expected values are never changed to match the implementation. See [Specifications](/guide/specifications) for the review workflow.

## Test outcomes

Assessments are vectors (specification relevance, assertion relevance, mutation detection, boundary coverage, formal evidence, source confidence, unknowns), summarized as one of `meaningful_with_evidence`, `weak_or_incomplete`, `tautological_or_disconnected`, `spec_conflict`, `inconclusive`. There is no single quality score.

A test is `meaningful_with_evidence` only when an asserted call to a project function kills specification-relevant mutants and asserts every decisive boundary input. Mutation results are recorded per test. When any call in the test goes through a relative import that TypeScript could not resolve, or the test runs code in a child process or through a dynamic import, that code may be what detected the mutants, so the outcome is `inconclusive` and the reason is listed under unknowns.
