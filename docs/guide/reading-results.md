# Reading results

Every run ends with a verdict, an exit code, a list of findings and per-test assessments. This page explains each of them. The full definitions are in [Semantics](/concepts/semantics).

## Verdicts and exit codes

| Verdict              | Exit code | Meaning                                                                                         |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `pass`               | `0`       | Every stage succeeded, nothing is inconclusive and there is nothing to review                   |
| `pass_with_warnings` | `0`       | No policy failure, but there are findings to review or inconclusive results (listed as reasons) |
| `policy_failure`     | `1`       | A confirmed specification violation, or a configured threshold was not met                      |
| `inconclusive`       | `4`       | Something could not be decided and `policy.inconclusiveBehavior` is `fail`                      |
| `tool_error`         | `3`       | A stage failed or ended in an error                                                             |

Exit code `2` means a configuration or usage error, such as a missing `.veritas/config.json` (`CONFIG_MISSING`) or a wrong approval token. Errors are printed as `error[CODE]: message` with a `hint:` line.

Only confirmed findings can fail the policy. Suspected findings never do. Inconclusive results never produce `pass`: with the default `warn` policy the verdict is `pass_with_warnings` and each inconclusive item is listed.

With `--json`, stdout holds only the JSON result (`status`, `exitCode`, `runId`, `dir`, `reasons`, `stages`, `findings`) and logs go to stderr.

## Stages

Each line of the run summary is a stage with a status. Only `succeeded` is a success. `failed` and `error` are tool errors; `partial`, `skipped`, `unsupported`, `timeout` and `cancelled` are inconclusive.

## Findings

```text
F-89435b62ae1e  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
```

A finding has a stable ID, a kind, a certainty and a severity.

| Certainty       | Meaning                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`     | Backed by a real run (a mutation run, or a counterexample replayed in JavaScript) and, for specification violations, an accepted property |
| `suspected`     | Plausible, but a person has to review it (for example, the property is only proposed)                                                     |
| `informational` | Explains a limitation                                                                                                                     |

Severity is one of `critical`, `high`, `medium`, `low` and `info`.

| Kind                           | Typical cause                                              |
| ------------------------------ | ---------------------------------------------------------- |
| `spec_implementation_mismatch` | The code disagrees with a documented rule                  |
| `counterexample`               | A property-based test or solver found a violating input    |
| `spec_violation_candidate`     | A test built from the specification fails against the code |
| `spec_conflict`                | Two sources state different rules                          |
| `survived_mutant`              | No test notices a change in specification-relevant code    |
| `test_gap`                     | A boundary or behaviour is not checked                     |
| `tautological_test`            | A test does not check project behaviour                    |
| `unsupported_semantics`        | Code outside the supported formal subset                   |
| `stage_failure`                | A stage could not produce its result                       |

Confirmed findings of the first three kinds are specification violations; with the default `policy.confirmedViolation: fail` they produce exit code `1`.

## Explaining a finding

```bash
veritas explain <finding-id>
```

`explain` prints the evidence chain: the source and the quoted line, the properties, the tests that reach the code, their assessments, the mutants, and the solver claims with the path to the SMT or Lean file. The last lines suggest what to do next. The [tutorial](/guide/tutorial) shows a full example.

## Test outcomes

Each test gets one of five outcomes:

| Outcome                        | Meaning                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `meaningful_with_evidence`     | An asserted call to a project function kills specification-relevant mutants and asserts every decisive boundary input                           |
| `weak_or_incomplete`           | The test checks something, but relevant mutants survive or a boundary is not exercised                                                          |
| `tautological_or_disconnected` | The test does not check project behaviour (constant assertions, the target is never called)                                                     |
| `spec_conflict`                | The test relates to properties whose sources conflict                                                                                           |
| `inconclusive`                 | Not enough evidence to decide: for example, no mutation results in this run, or the code is reached through a dynamic import or a child process |

The outcome summarizes an evidence vector. It is not a grade.

## The evidence vector

Each assessment in `assessments.json` carries these fields, with no combined score:

| Field                    | Contents                                                                          |
| ------------------------ | --------------------------------------------------------------------------------- |
| `specificationRelevance` | The properties the test relates to, with their review status                      |
| `assertionRelevance`     | `checks_result`, `weak`, `none` or `unknown`                                      |
| `mutationDetection`      | Mutants this test killed, mutants that survived it, and others                    |
| `boundaryCoverage`       | Each relevant boundary and whether the test exercises it (`yes`, `no`, `unknown`) |
| `formalEvidence`         | IDs of formal claims about the related properties                                 |
| `sourceConfidence`       | Notes on the quality of the specification sources                                 |
| `unknowns`               | What could not be determined, in words                                            |

The text report shows the same thing as a rationale line:

```text
T-97fef42e4cf7: weak_or_incomplete; rationale boundary not exercised: total >= 1000 (decisive inputs 999, 1000; asserted: none); formal evidence C-8aad536f8e71 counterexample_found (conformance, assurance none); unknowns no mutation results for this run; detection power not measured
```

## Verification statuses

Formal claims (Z3, Lean) have one of these statuses:

| Status                 | Meaning                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `proven_within_model`  | No counterexample exists within the stated model, domain bounds and assumptions               |
| `counterexample_found` | The solver found a violating input, and replaying it in JavaScript gave the same result       |
| `semantic_mismatch`    | The solver's counterexample does not reproduce in JavaScript: the model and the code disagree |
| `unknown`              | The solver gave no answer                                                                     |
| `timeout`              | The solver ran out of time (`formal.maxSolverMs`)                                             |
| `unsupported`          | The code or property is outside the supported subset                                          |
| `error`                | The tool failed                                                                               |

`unknown`, `timeout`, `unsupported`, `semantic_mismatch` and `error` are never counted as success. Each of them means that the question was not answered, and Veritas will not report an unanswered question as a passed check. They make the run inconclusive; whether that fails CI is up to `policy.inconclusiveBehavior`.

Claims also carry an assurance level: `smt_bounded` for Z3, `kernel_checked` for a Lean proof without `sorry`, `admit` or extra axioms, `none` otherwise. See [Verification](/guide/verification).

## Mutant statuses

| Status                                                     | Meaning                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `killed`                                                   | At least one test failed under the mutant                                                          |
| `survived`                                                 | Tests ran the mutant and none failed. A test gap candidate, not a bug and not proof of equivalence |
| `timeout`                                                  | The test run did not finish under the mutant. Counted as detected, never credited to one test      |
| `suspected_equivalent`                                     | No difference observed; equivalence not shown                                                      |
| `equivalent_proven`                                        | No input in the stated bounded domain distinguishes it from the original                           |
| `compile_error`, `runtime_error`, `ignored`, `no_coverage` | Reported by the mutation backend                                                                   |
| `pending`, `unknown`                                       | Not run, or a status Veritas does not recognize. Makes the mutation stage `partial`                |

A survived mutant is never treated as equivalent on its own. Only a bounded equivalence proof makes it `equivalent_proven`.

## Reports

```bash
veritas report                        # text summary of the latest run
veritas report --format markdown
veritas report --format html > report.html
veritas report --format sarif > veritas.sarif
veritas report --format json
veritas report --run <run-id>         # a specific run instead of the latest
```

Each run also writes `report.json`, `report.md`, `report.html` and `report.sarif` to its run directory. The report has ten sections: run metadata, collected evidence, the property ledger, specification mismatches, the tests by properties matrix, mutation outcomes, formal claims, test assessments, improvement proposals and limitations. The [reports reference](/reference/reports) describes the formats and the artifact files.
