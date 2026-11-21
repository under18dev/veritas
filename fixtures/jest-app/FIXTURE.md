# Fixture: jest-app

The discount-boundary project tested with Jest 30 instead of Vitest: native ESM (`"type": "module"`), TypeScript whose types Node strips (`transform: {}`, no ts-jest or babel), and `.js` import specifiers mapped to the `.ts` files.

| Item                             | Ground truth                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Test runner                      | Jest: `jest.config.mjs`, the test script runs `jest/bin/jest.js`, `jest` in devDependencies               |
| README discount rule             | `total >= 1000` (README.md line 7)                                                                         |
| Implementation                   | `total > 1000` (src/pricing.ts line 3): mismatch at the boundary; the `>` to `>=` mutant survives          |
| `test/discount-weak.test.ts`     | Jest globals without an import; calls `discountAmount` but never tests the boundary                       |
| `test/shipping-boundary.test.ts` | imports from `@jest/globals`; nested `describe`, both sides of the `shippingFee` boundary, `test.each`, `xit` |
| `test/checkout-mocks.test.ts`    | `jest.fn()` callbacks passed to `checkout`                                                                 |
| `test/tautological.test.ts`      | asserts a constant; never calls the implementation                                                         |
| Tests                            | 9 registrations (a `test.each` counts once); Jest runs 10 tests, one of them skipped                       |
