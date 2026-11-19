# Fixture: discount-boundary

| Item                             | Ground truth                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| README discount rule             | `total >= 1000` (README.md line 7)                                                   |
| Implementation                   | `total > 1000` (src/pricing.ts line 3): mismatch at the boundary                     |
| Counterexample                   | `total = 1000`: README expects 100, implementation returns 0                         |
| `test/tautological.test.ts`      | asserts a constant; never calls the implementation                                   |
| `test/discount-weak.test.ts`     | calls `discountAmount` but never tests the boundary; the `>` to `>=` mutant survives |
| `test/shipping-boundary.test.ts` | tests both sides of the `shippingFee` boundary; boundary mutants are killed          |
| `candidates/pricing-fixed.ts`    | conforms to the README rule within any bounded integer domain                        |

Expected normalized outputs live in `expected/`. They are written by hand from this table, never copied from tool output.
