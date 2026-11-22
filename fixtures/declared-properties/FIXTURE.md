# Fixture: declared-properties

Properties declared in `.veritas/config.json` (`properties`) instead of discovered in documents. Discovery is
off (`sources.local: false`). Both declarations are accepted in `.veritas/approvals.json`.

| Item                                           | Ground truth                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `D-stage.guarded-succeeded-needs-tests`        | holds: `guardedStatus` is partial when `testsRan <= 0`; `proven_within_model` by Z3 and by Lean     |
| `D-stage.unguarded-succeeded-needs-tests`      | does not hold (negative control): `counterexample_found` with `testsRan <= 0` and nothing undecided, replayed in JavaScript |
| `statusCode`                                   | returns a number: a `holds_for_all` declaration on it is `unsupported`                              |
| `invariant_loops`                              | uses a loop: a declaration on it is `unsupported` (outside the formal subset)                       |
| `invariant_hidden`                             | not exported: a declaration on it is `unsupported`                                                  |

`scripts/check-self-verification.mjs --root fixtures/declared-properties --expect-counterexample
stage.unguarded-succeeded-needs-tests` checks a `veritas prove --engine both` run of this fixture.
