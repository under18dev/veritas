# Troubleshooting

## Debugging a run

| Tool                                 | What it gives you                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--debug` (or `VERITAS_DEBUG=1`)     | Debug events on stderr: every child process (command, arguments, working directory, duration, exit code, timeout or kill), restricted calls of project code, stage start and end, cache hits and misses |
| `--log-format json`                  | The stderr log as one JSON object per line (`time`, `level`, `message`, and fields such as `event`, `stage`, `durationMs`). stdout is unaffected, so `--json` output stays pure JSON                    |
| `.veritas/runs/<run-id>/trace.jsonl` | The same events, debug level included, for every run. At most 4 MB; a final line says how many events were dropped                                                                                      |
| `veritas replay <run-id>`            | Re-runs a run with its recorded stages and options                                                                                                                                                      |
| `veritas report --run <run-id>`      | The report of a specific run                                                                                                                                                                            |

Logs and traces never include environment values or file contents, and everything is redacted.

```bash
veritas --debug --log-format json run --profile standard 2> veritas-log.jsonl
```

A line of `trace.jsonl`:

```json
{
  "event": "stage",
  "stage": "index",
  "at": "end",
  "status": "succeeded",
  "durationMs": 4,
  "time": "2026-11-20T10:10:38.818Z",
  "level": "debug",
  "message": "stage index succeeded in 4 ms"
}
```

`replay` prints which run it replays and then runs it again:

```text
replaying prove from run-20261120T100953080Z-000-c700bf (prove --include-proposed)
```

## Common problems

| Symptom                                                           | Cause and fix                                                                                                                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEST_NOT_FOUND`                                                | Install Vitest in the project (`pnpm add -D vitest`)                                                                                                                               |
| `CONFIG_MISSING`                                                  | Run `veritas init --yes`, or commit `.veritas/config.json` so CI has it                                                                                                            |
| `NO_RUN`                                                          | `spec`, `report`, `explain` and `improve` read the latest run; run `veritas run` first                                                                                             |
| `mutate` disabled in `doctor`                                     | Install `@mizchi/mutator` in the project or install the project's dependencies                                                                                                     |
| Mutation stage `failed`                                           | The project's own tests fail; fix the baseline first                                                                                                                               |
| `semantic_mismatch`                                               | The integer model and JavaScript disagree (for example, overflow beyond safe integers); narrow `formal.integerDomain` or rely on tests                                             |
| `unsupported` claims                                              | The function uses constructs outside the formal subset; see the [support matrix](/concepts/support-matrix)                                                                         |
| `timeout` claims                                                  | The solver ran out of time; raise `formal.maxSolverMs` or narrow `formal.integerDomain`                                                                                            |
| Lean `unavailable`                                                | Install Lean with elan; `doctor` also looks in `~/.elan/bin`                                                                                                                       |
| `sandbox` capability `unavailable`                                | Node.js below 25 cannot block network access from project code; install Node.js 25+ or point `VERITAS_SANDBOX_NODE` at one (`sandbox.allowNetworkWithoutIsolation` runs it anyway) |
| Running out of memory is an `error`                               | Raise `limits.memoryMb` (default 2048 MiB) for project code, the test runner, mutator and the Z3 process                                                                           |
| `PROPERTY_NOT_FOUND`, or an accepted property is `proposed` again | A property's ID comes from the text of its statement and source. After that text changes, it is a new property: run `veritas spec diff` to see it and review it                    |
| `IMPROVE_APPLY_IN_CI`                                             | Applying improvements is refused in CI by design; apply locally                                                                                                                    |
| `APPROVAL_MISMATCH`                                               | The token does not belong to this plan, or the plan changed; run `veritas improve --dry-run` again and use the new token                                                           |
| `IMPROVE_UNSAFE_LINK`                                             | The project has symbolic links pointing outside it; replace them with real files or directories before applying                                                                    |
| A statement in the docs is not found                              | The rule-based extractor reads threshold phrases; other statements stay unmapped. An [LLM provider](/guide/llm-providers) can read some of them as proposed properties             |

If a problem is not listed here, open an issue with the output of `veritas doctor --json` and the relevant part of `trace.jsonl`.
