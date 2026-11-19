# Semantics of results

## What a status means

| Status                 | Meaning                                                                                                            | Not to be read as                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `proven_within_model`  | The solver found no counterexample for the stated property, within the stated model, domain bounds and assumptions | The implementation is correct; the specification is correct |
| `counterexample_found` | The solver produced an assignment violating the property, and re-running it in JavaScript gave the same verdict    | A confirmed bug in the specification's intent               |
| `semantic_mismatch`    | The solver's counterexample does not reproduce in JavaScript; the model and the code disagree                      | Either a bug or a proof                                     |
| `unknown`, `timeout`   | The solver gave no answer                                                                                          | Success                                                     |
| `unsupported`          | The code or property is outside the supported subset                                                               | Success                                                     |
| `error`                | The tool failed                                                                                                    | Success                                                     |

Lean results carry `kernel_checked` assurance only without `sorry`, `admit` or extra axioms (ADR 0005). SMT results carry `smt_bounded` assurance. Reports show the difference.

## Supported formal subset

- Pure functions with no side effects, I/O, async, `this`, closures over mutable state, `eval` or `Proxy`.
- Parameters and results that are booleans or integers. Integer parameters must have an explicit bounded domain inside the safe-integer range (default `[-10000, 10000]`).
- Comparison, integer `+ - *`, logical operators, `if`/`else`, ternaries and conditional `return`.

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

## Specifications

- Properties start as `proposed`. Only an explicit approval record makes one `accepted`.
- Properties inferred from code, tests or runtime observation are never independent evidence for themselves.
- Conflicting sources produce `conflicted`; Veritas proposes a preferred reading with both sources but does not pick one.

## Test outcomes

Assessments are vectors (specification relevance, assertion relevance, mutation detection, boundary coverage, formal evidence, source confidence, unknowns), summarized as one of `meaningful_with_evidence`, `weak_or_incomplete`, `tautological_or_disconnected`, `spec_conflict`, `inconclusive`. There is no single quality score.
