# Semantics of results

## What a status means

| Status                 | Meaning                                                                                                            | Not to be read as                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `proven_within_model`  | The solver found no counterexample for the stated property, within the stated model, domain bounds and assumptions | The implementation is correct; the specification is correct |
| `counterexample_found` | The solver produced an assignment violating the property, and re-running it in JavaScript gave the same verdict    | A confirmed bug in the specification's intent               |
| `semantic_mismatch`    | The solver's counterexample does not reproduce in JavaScript; the model and the code disagree                      | Either a bug or a proof                                     |
| `unknown`, `timeout`   | The solver gave no answer, or the model could not be compared with the JavaScript code                             | Success                                                     |
| `unsupported`          | The code or property is outside the supported subset                                                               | Success                                                     |
| `error`                | The tool failed                                                                                                    | Success                                                     |

Lean results carry `kernel_checked` assurance only without `sorry`, `admit` or extra axioms (ADR 0005). SMT results carry `smt_bounded` assurance. Reports show the difference.

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
- `pending`, `unknown`: the mutant was not run, or the backend reported a status Veritas does not recognize. An `unknown` mutant makes the mutation stage `partial`, so the run cannot `pass`; so does a `pending` one, except in an incremental run (`--since`), where mutants outside the change are left out on purpose.

## Specifications

- Properties start as `proposed`. Only an explicit approval record makes one `accepted`.
- Properties inferred from code, tests or runtime observation are never independent evidence for themselves.
- Conflicting sources produce `conflicted`; Veritas proposes a preferred reading with both sources but does not pick one.

## Test outcomes

Assessments are vectors (specification relevance, assertion relevance, mutation detection, boundary coverage, formal evidence, source confidence, unknowns), summarized as one of `meaningful_with_evidence`, `weak_or_incomplete`, `tautological_or_disconnected`, `spec_conflict`, `inconclusive`. There is no single quality score.

A test is `meaningful_with_evidence` only when an asserted call to a project function kills specification-relevant mutants and asserts every decisive boundary input. Mutation results are recorded per test. When any call in the test goes through a relative import that TypeScript could not resolve, that call may be what detected the mutants, so the outcome is `inconclusive` and the unresolved import is listed under unknowns.
