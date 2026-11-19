# ADR 0006: Mutation backend

## Context

Mutation results must be real, reproducible and normalized into Veritas's domain model without re-implementing a mutation tool.

## Decision

- Use `@mizchi/mutator` through its CLI, reading its `mutation-testing-elements` (schemaVersion 2) JSON report and its agent report.
- Detect capabilities from `mutator --version` and `--help` and pin a tested version range; unknown versions run in a degraded mode with a warning.
- Map statuses one-to-one where possible. A survived mutant is never `equivalent_proven` without a bounded proof; mutator's accepted equivalents are reported as `ignored` with their reason.
- Existing mutation-testing-elements JSON (for example from StrykerJS) can be imported instead of running a backend.

## Consequences

Mutator's in-memory instrumentation cannot see code run in child processes; those mutants are reported with their reason rather than as survivors.
