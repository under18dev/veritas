# Performance

How long Veritas takes and how much memory it uses on real open-source projects, and what to do when a project is too large for a full run.

## Measurements

Measured on 2026-11-21 with Veritas at commit `44074b1`, on a MacBook (Apple M4, 16 GB), macOS 26, Node.js 26.13.1. Each row is one `veritas` process run with `--offline` and no LLM; the time is wall-clock time and the memory is the peak resident set size of the Veritas process. Runs marked "cold" had the cache turned off (`cache.enabled: false`), so no earlier result was reused; runs with `--scope` or `--since` still mutated only that part.

### `run --profile quick`

The quick profile indexes code and tests, collects specifications and assesses the tests statically. It runs no project code.

| Project (commit)      | Functions | Tests | Time   | Peak memory |
| --------------------- | --------- | ----- | ------ | ----------- |
| unjs/defu (82632b6)   | 3         | 23    | 1.5 s  | 437 MB      |
| unjs/scule (5bc6804)  | 11        | 11    | 1.3 s  | 399 MB      |
| antfu/utils (91f8cf7) | 80        | 32    | 1.4 s  | 332 MB      |
| unjs/pathe (bc7477a)  | 50        | 62    | 1.7 s  | 467 MB      |
| unjs/ufo (f06c800)    | 70        | 54    | 1.4 s  | 324 MB      |
| valibot (40fae94)     | 299       | 3,194 | 11.4 s | 1,089 MB    |
| es-toolkit (24e7a7b)  | 840       | 5,333 | 12.1 s | 1,459 MB    |
| hono (75ff8e3)        | 654       | 3,298 | 10.7 s | 1,320 MB    |
| date-fns (a9739fb)    | 916       | 2,900 | 8.6 s  | 954 MB      |
| zod (2a343ed)         | 1,128     | 2,721 | 15.0 s | 1,903 MB    |

"Tests" counts test registrations: a loop or `.each` counts once. Most of the time on the larger projects goes to the `map` stage, which reads every test file with the TypeScript compiler.

### Runs with mutation testing (cold)

| Project    | Command                                              | Mutants (excluding pending)    | Time   | Peak memory |
| ---------- | ---------------------------------------------------- | ------------------------------ | ------ | ----------- |
| defu       | `run --profile standard`                             | 107                            | 5.4 s  | 528 MB      |
| ufo        | `run --profile standard`                             | 1,109                          | 44.4 s | 2,050 MB    |
| valibot    | `mutate --scope src/actions/minValue/minValue.ts`    | 22                             | 14.6 s | 891 MB      |
| es-toolkit | `run --profile deep --since <ref>` (4 changed files) | 68 (13,134 outside the change) | 45.1 s | 1,380 MB    |

Mutation testing takes most of these runs: 42.7 s of the 44.4 s for ufo, 27.1 s of the 45.1 s for es-toolkit. Its time grows with the number of mutants and with how long the tests that cover them take. With `--since`, the tests that reach a changed file are run, plus tests whose reach static analysis cannot see (dynamic imports, unresolved imports, custom registrations), and mutants of unchanged files stay `pending`.

pathe has about 1,020 mutants; two cold `run --profile standard` runs took 98.6 s and 93.1 s (peak memory 2.2 GB). That is close to the default `mutation.timeoutMs` of 120 s: the first run stopped 4 mutants short, so its `mutate` stage was `partial` and the run listed `inconclusive (warn): stage mutate=partial` among its reasons (verdict `pass_with_warnings`, exit code 0 under the default `warn` policy). On a slower machine the stage can end with `timeout` instead. Neither is counted as a complete mutation result.

## Large projects

- Start with `quick`. It runs no project code and took at most 15 s on the projects above, with up to 5,333 tests.
- Run mutation testing on what changed: `--since <ref>` in pull requests, or `mutate --scope <path>` for one area. `--scope` can be given more than once.
- Raise `mutation.timeoutMs` when a full mutation run needs longer than 120 s.
- When a mutation run times out before any mutant has finished and the message says mutator had not printed its plan, mutator most likely spent the time type-checking the mutants. `mutation.typecheck: "off"` skips that step; see [Troubleshooting](/guide/troubleshooting).
- Mutation results, decisive solver results and LLM responses are cached in `.veritas/cache/`, keyed by content. A run reuses them when the code, the configuration, the tool versions and the run's options (such as `--scope` or `--since`) are unchanged.

The budget that CI enforces on the fixtures is in [ADR 0009](/adr/0009-performance-budget).
