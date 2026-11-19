# Fixture: equivalent-mutants

| Mutant                                             | Ground truth                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x > 0` -> `x >= 0` in `relu` (src/math.ts line 3) | Equivalent for every integer: at x = 0 both return 0. Must become `equivalent_proven` with the bounded domain recorded, never just "survived = equivalent" |
| Survivors in `smaller` (uses `Math.min`)           | Outside the formal subset: equivalence cannot be decided; they stay `survived`                                                                             |
