# Fixture: solver-limits

| Item              | Ground truth                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sumsTo33`        | `a³ + b³ + c³ = 33` has no integer solution with each value in `[-10000, 10000]` (the smallest known solution has 16-digit values), so the function returns 0 on the whole domain |
| Surviving mutants | e.g. `return 0`, `- c * c * c`: deciding their bounded equivalence is a sum-of-cubes search that Z3 cannot finish in a short time limit                                          |
| Expected claims   | with `formal.maxSolverMs` of a few seconds, those `bounded_equivalence` claims are `timeout`; the mutants stay `survived`, never `equivalent_proven`                             |
| Policy            | timeouts are inconclusive: `pass_with_warnings` by default, exit 4 with `policy.inconclusiveBehavior: fail`                                                                      |
