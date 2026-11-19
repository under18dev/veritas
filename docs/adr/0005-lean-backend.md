# ADR 0005: Lean backend and proof acceptance

## Context

Lean kernel checks give stronger assurance than bounded SMT results, but only if the proof contains no `sorry`, `admit` or added axioms, and the Lean model's correspondence to the JavaScript code remains a separate obligation.

## Decision

- Lean 4 and `lake` are external tools detected by `veritas doctor`; when absent, Lean claims are `unsupported` with a clear reason.
- Generated Lean files are compiled with `lake build`. A claim is `kernel_checked` only if the build succeeds and `#print axioms` for the theorem lists nothing beyond Lean's standard axioms (`propext`, `Classical.choice`, `Quot.sound`). Any `sorry`, `admit`, other axiom or `native_decide` makes the claim fail.
- The model-to-implementation correspondence is reported as an unmet obligation unless separately established.

## Consequences

Reports distinguish `smt_bounded` from `kernel_checked` assurance.
