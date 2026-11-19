# ADR 0002: Schemas, artifact envelopes and versioning

## Context

Every result must be machine-readable, validated, traceable to its inputs and comparable between runs.

## Decision

- Domain types are Zod schemas in `@under18dev/veritas-core`; TypeScript types are inferred from them. `pnpm schemas` writes JSON Schema to `schemas/`, and CI fails if it is stale.
- Every persisted artifact is an envelope `{ meta, data }`. `meta` holds `schemaVersion`, `runId`, `createdAt`, `toolVersion`, `gitCommit`, `configHash`, `sourceHash`.
- Artifacts are validated before writing and after reading, redacted before writing, and written atomically.
- Reading an artifact with a different `schemaVersion` fails with an actionable error. When the schema changes incompatibly, the version is bumped and a migration is added next to the schema; until then old runs must be re-run.
- IDs are content-derived (`stableId(prefix, identity)`) so the same entity keeps its ID across runs. Run IDs are time-ordered.
- Integers in the Property IR are decimal strings so values outside the safe-integer range stay exact.

## Consequences

Schema changes are visible in review through the `schemas/` diff.
