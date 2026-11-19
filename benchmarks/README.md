# Benchmarks

`node benchmarks/run.mjs [profile ...]` runs `veritas run` on copies of the fixtures for each profile and writes wall-clock time, counts and usage counters (solver time, mutants, test runs, LLM tokens) to `benchmarks/results/<date>-<platform>.json`.

Results are measurements on the recording machine. `node benchmarks/run.mjs --check` also fails when a run exceeds the budget in `budget.json`; see [ADR 0009](../docs/adr/0009-performance-budget.md).
