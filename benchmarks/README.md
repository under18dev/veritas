# Benchmarks

`node benchmarks/run.mjs [profile ...]` runs `veritas run` on copies of the fixtures for each profile and writes wall-clock time, counts and usage counters (solver time, mutants, test runs, LLM tokens) to `benchmarks/results/<date>-<platform>.json`.

Results are measurements on the recording machine. `node benchmarks/run.mjs --check` also fails when a run exceeds the budget in `budget.json`; see [ADR 0009](../docs/adr/0009-performance-budget.md).

`results/2026-11-21-real-projects-darwin.json` records runs on ten open-source projects (time, peak memory, counts and time per stage); the [performance page](../docs/concepts/performance.md) summarises it.

## Pull requests

The `benchmark` workflow measures the base and the head of every pull request one after the other on the same runner, and the `benchmark-comment` workflow posts the comparison as one comment, updated on each push:

- `node benchmarks/run.mjs --cli <bin.js> --out <file>`: the fixtures, with the given build.
- `node benchmarks/real.mjs --work <dir> --cli <bin.js> --out <file>`: the quick profile on the projects in `real-projects.json`, cloned at their pinned commits; dependencies are installed with lifecycle scripts disabled, and the quick profile runs no project code.
- `node benchmarks/compare.mjs --base <file> --head <file> [--real-base <file> --real-head <file>]`: the Markdown report.

The measuring workflow has read-only permissions and no secrets. The commenting workflow runs no code from the pull request: it reads the report as text and comments only when the pull request's head is the measured commit.
