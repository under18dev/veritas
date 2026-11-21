# Benchmarks

`node benchmarks/run.mjs [profile ...]` runs `veritas run` on copies of the fixtures for each profile and writes wall-clock time, counts and usage counters (solver time, mutants, test runs, LLM tokens) to `benchmarks/results/<date>-<platform>.json`.

Results are measurements on the recording machine. `node benchmarks/run.mjs --check` also fails when a run exceeds the budget in `budget.json`; see [ADR 0009](../docs/adr/0009-performance-budget.md).

`results/2026-11-21-real-projects-darwin.json` records runs on ten open-source projects (time, peak memory, counts and time per stage); the [performance page](../docs/concepts/performance.md) summarises it.
