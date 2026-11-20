# Reading results

This page explains the verdict, the exit code, findings, test outcomes and the statuses that appear in Veritas output. The exact definitions are in [Semantics](/concepts/semantics).

## Verdict and exit code

The first line of every run shows both:

```text
run run-20261120T105508829Z-000-017911  verdict: policy_failure (exit 1)
```

| Verdict              | Exit code | Meaning                                                                     |
| -------------------- | --------- | --------------------------------------------------------------------------- |
| `pass`               | `0`       | Every stage succeeded, nothing is inconclusive and nothing needs review     |
| `pass_with_warnings` | `0`       | No policy failure, but there are findings to review or inconclusive results |
| `policy_failure`     | `1`       | A confirmed specification violation, or a configured threshold is not met   |
| `tool_error`         | `3`       | A stage failed                                                              |
| `inconclusive`       | `4`       | Something could not be decided and `policy.inconclusiveBehavior` is `fail`  |

Exit code `2` means a configuration or usage error, printed as `error[CODE]: message` followed by a `hint:` line, for example:

```text
error[APPROVAL_MISMATCH]: the approval token does not match plan IP-a14164357e16 (the plan changed or the token is wrong)
hint: review the plan again with `veritas improve --dry-run` and use the token it prints
```

Only confirmed findings fail the policy. Inconclusive results never produce `pass`: under the default `warn` policy the verdict is `pass_with_warnings` and each inconclusive item is listed. [CI and GitHub Action](/guide/ci#choose-what-fails-the-build) shows how to configure the policy.

With `--json`, stdout contains only the JSON result (`status`, `exitCode`, `runId`, `dir`, `reasons`, `stages`, `findings`) and logs go to stderr.

## Stages

Each block under the verdict is a stage and its status. Only `succeeded` is a success. `failed` and `error` are tool errors. `partial`, `skipped`, `unsupported`, `timeout` and `cancelled` are inconclusive.

## Findings

```text
F-89435b62ae1e  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
```

Each finding has an ID, a certainty, a severity and a kind.

| Certainty       | Meaning                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`     | Shown by a real run (a mutation run, or a counterexample replayed in JavaScript); for a specification violation, the property is accepted |
| `suspected`     | Needs your review, for example because the property is only proposed                                                                      |
| `informational` | Describes a limitation of the analysis                                                                                                    |

Severity is `critical`, `high`, `medium`, `low` or `info`.

| Kind                           | Typical cause                                               |
| ------------------------------ | ----------------------------------------------------------- |
| `spec_implementation_mismatch` | The code disagrees with a documented rule                   |
| `counterexample`               | A property-based test or the solver found a violating input |
| `spec_violation_candidate`     | A test built from the specification fails against the code  |
| `spec_conflict`                | Two sources state different rules                           |
| `survived_mutant`              | No test notices a change in code that a rule depends on     |
| `test_gap`                     | A boundary or behaviour is not checked                      |
| `tautological_test`            | A test does not check project behaviour                     |
| `unsupported_semantics`        | Code outside the supported formal subset                    |
| `stage_failure`                | A stage could not produce its result                        |

A confirmed finding of one of the first three kinds is a specification violation and, with the default `policy.confirmedViolation: fail`, sets exit code `1`.

## See the evidence for a finding

```bash
veritas explain <finding-id>
```

`explain` reads the latest run and prints the source and quoted line, the properties, the tests that call the code and their assessments, the mutants, the solver claims with their files, and the suggested next steps. The [tutorial](/guide/tutorial#_3-see-the-evidence-for-a-finding) shows a full example.

## Test outcomes

| Outcome                        | Meaning                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `meaningful_with_evidence`     | The test asserts the result of a project function, kills specification-relevant mutants and asserts every decisive boundary input |
| `weak_or_incomplete`           | The test checks something, but relevant mutants survive it or it misses a boundary                                                |
| `tautological_or_disconnected` | The test does not check project behaviour (constant assertions, the target is never called)                                       |
| `spec_conflict`                | The test relates to a property whose sources conflict                                                                             |
| `inconclusive`                 | There is not enough evidence: the run has no mutation results, or the code is reached through a dynamic import or a child process |

The outcome summarizes the evidence vector below; it is not a grade.

## Evidence vector

Each assessment in `assessments.json` has these fields and no combined score:

| Field                    | Contents                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `specificationRelevance` | Properties the test relates to, with their review status                     |
| `assertionRelevance`     | `checks_result`, `weak`, `none` or `unknown`                                 |
| `mutationDetection`      | Mutants the test killed, mutants that survived it, others                    |
| `boundaryCoverage`       | Each relevant boundary and whether the test uses it (`yes`, `no`, `unknown`) |
| `formalEvidence`         | IDs of formal claims about the related properties                            |
| `sourceConfidence`       | Notes on the quality of the specification sources                            |
| `unknowns`               | What could not be determined                                                 |

`veritas report` prints the same information as a rationale line:

```text
T-97fef42e4cf7: weak_or_incomplete; rationale boundary not exercised: total >= 1000 (decisive inputs 999, 1000; asserted: none); formal evidence C-8aad536f8e71 counterexample_found (conformance, assurance none); unknowns no mutation results for this run; detection power not measured
```

## Verification statuses

| Status                 | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `proven_within_model`  | No counterexample exists within the stated model, domain bounds and assumptions         |
| `counterexample_found` | The solver found a violating input, and replaying it in JavaScript gave the same result |
| `semantic_mismatch`    | The solver's counterexample does not reproduce in JavaScript                            |
| `unknown`              | The solver gave no answer                                                               |
| `timeout`              | The solver hit `formal.maxSolverMs`                                                     |
| `unsupported`          | The code or property is outside the supported subset                                    |
| `error`                | The tool failed                                                                         |

`unknown`, `timeout`, `unsupported`, `semantic_mismatch` and `error` mean the question was not answered, so Veritas never counts them as success. They make the run inconclusive, and `policy.inconclusiveBehavior` decides whether that fails CI. [Verification](/guide/verification) explains each engine and the assurance levels `smt_bounded` and `kernel_checked`.

## Mutant statuses

| Status                                                     | Meaning                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `killed`                                                   | At least one test failed under the mutant                                                     |
| `survived`                                                 | Tests ran the mutant and none failed: a test gap candidate, not a bug and not equivalence     |
| `timeout`                                                  | The tests did not finish under the mutant; counted as detected but credited to no single test |
| `suspected_equivalent`                                     | No difference was observed; equivalence is not shown                                          |
| `equivalent_proven`                                        | No input in the stated bounded domain distinguishes it from the original                      |
| `compile_error`, `runtime_error`, `ignored`, `no_coverage` | Reported by the mutation backend                                                              |
| `pending`, `unknown`                                       | Not run, or not recognized; the mutation stage becomes `partial`                              |

A surviving mutant becomes `equivalent_proven` only through a bounded equivalence proof.

## Print a report

```bash
veritas report                          # text summary of the latest run
veritas report --format markdown
veritas report --format html > report.html
veritas report --format sarif > veritas.sarif
veritas report --format json
veritas report --run <run-id>           # a specific run
```

`veritas run` and `veritas prove` also write the report files listed in `reports.formats` (by default `report.json`, `report.md`, `report.html` and `report.sarif`) to the run directory; for runs of other commands, `veritas report` renders them on request. [Reports and artifacts](/reference/reports) describes the sections and files.
