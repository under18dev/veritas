# ADR 0009: Performance budget

## Context

Analysis must stay fast enough for local use and CI. A budget is only meaningful with a fixed workload, a measurement method and a recorded baseline.

## Decision

- Workload: every fixture listed in `benchmarks/run.mjs`, including `fixtures/small-app` (10 exported functions, 30 tests), run with `--offline --include-proposed` and no LLM.
- Measurement: wall-clock time of one `veritas run` process per fixture and profile, on the CI runners (ubuntu-latest, macos-latest, windows-latest).
- Budget per run (`benchmarks/budget.json`): `quick` 60 s, `standard` 120 s, `deep` 300 s. A run must also end with a verdict exit code (0, 1 or 4).
- Baseline (2026-11-19, macOS arm64, Node 26): `small-app` quick 1.2 s, standard 2.9 s, deep 4.7 s; every other fixture under 2.5 s in every profile. Results are in `benchmarks/results/`.
- CI runs `node benchmarks/run.mjs --check` on every OS and fails when a run exceeds the budget.
- Usage counters (LLM tokens, solver milliseconds, mutants, test runs) are recorded per stage in `run.json` and in reports; their budget is ADR 0010.

## Consequences

- The budget leaves a wide margin over the baseline, so it catches regressions such as hangs or an order-of-magnitude slowdown, not small drifts.
- Larger projects are expected to use `--since` or `analysis.include` to limit scope; stages that stop early report `partial`.
- Changing the workload or the budget requires a new ADR.
