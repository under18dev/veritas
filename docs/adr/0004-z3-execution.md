# ADR 0004: Running Z3

## Context

Formal claims must come from an actual solver run whose input and output are saved and can be re-run. Z3 must work in CI on Linux, macOS and Windows without a manual install.

## Decision

- Veritas generates SMT-LIB 2 text from the Property IR and saves it as an artifact before solving.
- The default engine is the `z3-solver` npm package (WebAssembly), evaluating the saved SMT-LIB text in a separate Node.js process (amended: originally a worker thread, which let a V8 fault in the engine end the whole run). A timeout or cancellation kills that process and yields `timeout` or `cancelled`; a crash yields `error`; the result is never inferred.
- If a native `z3` executable is on `PATH`, it can be selected instead; it is run on the same `.smt2` file.
- The solver version is recorded in every claim. `sat`, `unsat` and `unknown` are parsed strictly; anything else is `error`.

## Consequences

WebAssembly Z3 is slower than native for hard queries; the bounded integer subset keeps queries small. Results from both engines are comparable because they consume the same file.
