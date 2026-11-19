# ADR 0003: TypeScript Compiler API for code intelligence

## Context

Code intelligence needs exports, signatures, resolved types, branches and call sites. Oxc parses faster but does not resolve types.

## Decision

Use the TypeScript Compiler API (`typescript` 6.0.x) for parsing, type checking and symbol resolution. Analysis is static and never executes project code. Runtime observation is a separate, sandboxed step whose results are stored in separate fields.

## Consequences

Large projects are analysed per changed scope (`--since`) and cached by content hash. Oxc can be added later for fast pre-filtering without changing the domain model.
