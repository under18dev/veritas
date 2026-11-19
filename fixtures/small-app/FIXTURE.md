# Fixture: small-app

Sized for performance budgets: 10 exported functions and 30 tests, close to the "small project" in the performance ADR.

| Item              | Ground truth                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| README rules      | one threshold rule per function, all `>=` (README.md)                                                          |
| `loyaltyBonus`    | implemented with `>`: at `points = 300` README expects 50, implementation returns 0; the test pins the bug    |
| `expressFee`      | implemented with `>`: at `distance = 50` README expects 700, implementation returns 300; the test pins the bug |
| Other 8 functions | conform to their README rule                                                                                   |
| Tests             | 3 per function (below, at and far above the threshold), 30 in total                                           |

The rule-based extractor does not read every sentence as a threshold rule (for example "no student discount" has no numeric result). Such rules must be reported as unsupported or not formalized; the fixture only requires the two counterexamples above and no counterexample for the other functions.
