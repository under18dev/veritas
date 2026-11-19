# Fixture: order-records

Record and array parameters in the formal subset.

| Item                     | Ground truth                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| README discount rule     | `order.total >= 1000` gives 100, otherwise 0 (README.md line 7)                                        |
| `orderDiscount`          | `order.total > 1000` (src/order.ts line 8): mismatch at the boundary                                   |
| Counterexample           | `{ "order": { "total": 1000, "vip": <any> } }`: README expects 100, implementation returns 0           |
| README shipping rule     | item count `>= 3` is free, otherwise 500 (README.md line 11)                                           |
| `shippingFee`            | `items.length >= 3 ? 0 : 500` (src/order.ts line 16): conforms within any modelled array length        |
| `test/order.test.ts`     | never tests `total = 1000`; the `>` to `>=` mutant of `orderDiscount` survives                          |
