# Fixture: node-app

The discount-boundary project tested with Node's built-in test runner (`node --test`, `node:test` and `node:assert`) instead of Vitest: native ESM (`"type": "module"`), TypeScript whose types Node strips, imported by its `.ts` file names, and no dependencies at all.

| Item                             | Ground truth                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Test runner                      | Node.js test runner: the test script runs `node --test`, the test files import `node:test`; nothing to install              |
| README discount rule             | `total >= 1000` (README.md line 7)                                                                                           |
| Implementation                   | `total > 1000` (src/pricing.ts line 3): mismatch at the boundary                                                             |
| `test/discount-weak.test.ts`     | the default import of `node:test` and `node:assert/strict`; calls `discountAmount` but never tests the boundary (weak)      |
| `test/shipping-boundary.test.ts` | nested `describe`, both sides of the `shippingFee` boundary, `t.test` subtests with `t.assert`, `it.skip`, a `{ todo }` test |
| README wrapping rule             | `total >= 3000` (README.md line 15); the implementation (`isWrapped`, src/pricing.ts) conforms                               |
| `test/wrapping-weak.test.ts`     | calls `isWrapped` far from the boundary (weak); `improve` proposes `isWrapped(2999)` and `isWrapped(3000)`                  |
| `test/checkout-mocks.test.ts`    | `mock.fn()` from `node:test` passed to `checkout`                                                                            |
| `test/tautological.test.ts`      | asserts a constant; never calls the implementation                                                                           |
| Tests                            | 12 registrations; `node --test` reports 14 tests (the two subtests too), one skipped and one todo                           |
| Mutation                         | unsupported: @mizchi/mutator cannot run `node --test`, so no test is `meaningful_with_evidence`; `improve --apply` stops before writing anything |
