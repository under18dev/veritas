# Fixture: number-model

| Item                 | Ground truth                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| README discount rule | `total >= 1000` (README.md line 7)                                                                                                 |
| Implementation       | `total * 10^12 >= 1000 * 10^12` (src/pricing.ts): equal to the rule over mathematical integers                                     |
| Number semantics     | `total * 10^12` leaves the safe-integer range once `\|total\| > 9007`, which is inside the default domain `[-10000, 10000]`         |
| Expected claim       | the conformance claim for the accepted rule is `semantic_mismatch` naming the safe-integer range, never `proven_within_model`      |
| Tests                | `test/pricing.test.ts` checks both sides of the boundary                                                                           |
