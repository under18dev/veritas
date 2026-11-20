# ADR 0010: Usage budget

## Context

This extends ADR 0009.

ADR 0009 budgets wall-clock time per profile and records usage counters (LLM tokens, solver milliseconds, mutants, test runs) without budgeting them. Cost can regress without the run getting slower, for example a change that sends text to an LLM in an offline benchmark, runs the solver in a profile that should not, or generates far more mutants or property-test runs.

## Decision

- `benchmarks/budget.json` also has `maxUsage` per profile, checked by `node benchmarks/run.mjs --check` on every fixture:
  - `quick`: no LLM tokens, no solver time, no mutants, no test runs;
  - `standard`: no LLM tokens, no solver time, at most 500 mutants, no property-test runs;
  - `deep`: no LLM tokens, at most 60 s of solver time, at most 500 mutants and 20,000 property-test runs.
- The benchmarks run offline, so any LLM token is a regression.
- A run whose `run.json` has no usage counters fails the check.

## Consequences

- Limits leave a wide margin over the baseline (at most 80 mutants, 817 ms of solver time and 5,039 test runs on the fixtures), so they catch structural regressions, not drift.
- Changing the workload or these limits requires a new ADR.
