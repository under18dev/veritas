# Benchmarks

`node benchmarks/run.mjs [profile ...]` runs `veritas run` on copies of the fixtures for each profile and writes wall-clock time, counts and usage counters (solver time, mutants, test runs, LLM tokens) to `benchmarks/results/<date>-<platform>.json`.

Results are measurements on the recording machine. They are not guarantees, and no threshold is enforced until a baseline is agreed in an ADR.
