# Troubleshooting

This page lists common errors with their fixes, and the tools for finding out what a run did.

## Common problems

| Symptom                                                           | Cause and fix                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEST_NOT_FOUND`                                                | The project does not use Vitest. Install it (`npm install -D vitest`)                                                                                                                                      |
| `CONFIG_MISSING`                                                  | No `.veritas/config.json`. Run `veritas init --yes`, and commit the file for CI                                                                                                                            |
| `NO_RUN`                                                          | `spec`, `report`, `explain` and `improve` read the latest run. Run `veritas run` first                                                                                                                     |
| `mutate` disabled in `doctor`                                     | Vitest is not installed. Install the project's dependencies                                                                                                                                                |
| Mutation stage `failed`                                           | Your tests fail without any mutant. Make them pass first                                                                                                                                                   |
| `sandbox` is `unavailable` in `doctor`                            | Node.js below 25 cannot block network access from project code. Install Node.js 25 or later, or point `VERITAS_SANDBOX_NODE` at one. `sandbox.allowNetworkWithoutIsolation` runs the code without blocking |
| `semantic_mismatch`                                               | The integer model and JavaScript disagree, for example on values beyond safe integers. Narrow `formal.integerDomain`, or cover the function with tests                                                     |
| `unsupported` claims                                              | The function uses code outside the formal subset; see the [support matrix](/concepts/support-matrix)                                                                                                       |
| `timeout` claims                                                  | The solver hit its time limit. Raise `formal.maxSolverMs` or narrow `formal.integerDomain`                                                                                                                 |
| `error` from running out of memory                                | Raise `limits.memoryMb` (default 2048 MiB). It applies to project code, the test runner, mutator and Z3                                                                                                    |
| Lean is `unavailable` in `doctor`                                 | Install Lean 4 with elan. `doctor` also looks in `~/.elan/bin`                                                                                                                                             |
| `PROPERTY_NOT_FOUND`, or an accepted property is `proposed` again | The file containing the statement changed, so the property has a new ID. Run `veritas spec diff` and review the new property                                                                               |
| `APPROVAL_MISMATCH`                                               | The token does not belong to the plan, or the plan changed. Run `veritas improve --dry-run` again and use the new token                                                                                    |
| `IMPROVE_APPLY_IN_CI`                                             | `--apply` is refused in CI. Apply locally                                                                                                                                                                  |
| `IMPROVE_UNSAFE_LINK`                                             | The project contains symbolic links pointing outside it. Replace them with real files or directories                                                                                                       |
| A documented rule does not appear in `spec list`                  | The rules read threshold phrases only; other statements stay unmapped. An [LLM provider](/guide/llm-providers) can read some of them as proposed properties                                                |

## See what a run did

| Tool                                 | What it shows                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--debug` or `VERITAS_DEBUG=1`       | Debug events on stderr: every child process (command, arguments, working directory, duration, exit code, timeout or kill), restricted calls of project code, stage start and end, cache hits and misses |
| `--log-format json`                  | The stderr log as one JSON object per line. stdout is unchanged, so `--json` output stays pure JSON                                                                                                     |
| `.veritas/runs/<run-id>/trace.jsonl` | The same events, debug level included, for every run; at most 4 MB, with a final line counting dropped events                                                                                           |
| `veritas replay <run-id>`            | Runs a previous run again with its recorded stages and options                                                                                                                                          |
| `veritas report --run <run-id>`      | The report of a specific run                                                                                                                                                                            |

Logs and traces contain no environment values or file contents, and are redacted.

```bash
veritas --debug --log-format json run --profile standard 2> veritas-log.jsonl
```

Each line of `trace.jsonl` is one event:

```text
{"event":"stage","stage":"discover","at":"start","time":"2026-11-20T10:55:31.938Z","level":"debug","message":"stage discover started"}
```

`replay` names the run it repeats before running it:

```text
replaying prove from run-20261120T105508829Z-000-017911 (prove --include-proposed)
```

If your problem is not listed here, open an issue on [GitHub](https://github.com/under18dev/veritas/issues) with the output of `veritas doctor --json` and the relevant part of `trace.jsonl`.
