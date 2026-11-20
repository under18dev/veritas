# CLI reference

The `veritas` command runs the Veritas pipeline on a TypeScript or JavaScript project that uses Vitest. Every command goes through the same engine as the [Node API](/reference/api), the [MCP server](/reference/mcp) and the [GitHub Action](/reference/github-action), and writes the same artifacts under `.veritas/runs/<run-id>/` (see [Reports and artifacts](/reference/reports)).

```bash
veritas [global options] <command> [options]
```

## Machine-readable output

With `--json`, stdout carries exactly one JSON value and nothing else; progress messages and logs go to stderr. This holds for help and the version too (`{"status":"ok","help":"..."}`, `{"status":"ok","version":"..."}`) and for errors:

```json
{
  "status": "error",
  "category": "user",
  "code": "USAGE",
  "message": "unknown option '--frobnicate'",
  "hint": "run `veritas --help`",
  "exitCode": 2
}
```

Every error has a stable `code` (for example `CONFIG_MISSING`, `NO_RUN`, `ROOT_NOT_FOUND`, `IMPROVE_APPLY_IN_CI`) and usually a `hint`. `--log-format json` changes only the stderr log (one JSON object per line); it does not affect stdout.

`veritas report --json` is the same as `veritas report --format json`. Combining `--json` with another `--format` is a user error (`FORMAT_CONFLICT`).

## Exit codes

| Code | Meaning                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success. The verdict may still be `pass_with_warnings`: findings to review, or inconclusive results under a `warn` or `ignore` policy                                                |
| `1`  | Confirmed policy failure: a confirmed specification violation with `policy.confirmedViolation: fail`, or a threshold (`policy.maxNewSurvivors`, `policy.minPropertyCoverage`) missed |
| `2`  | Configuration or user error: invalid arguments, a missing or invalid configuration, an unknown id, a refused operation                                                               |
| `3`  | Tool or infrastructure error: a stage failed, a solver or child process crashed                                                                                                      |
| `4`  | Inconclusive under the configured policy (`policy.inconclusiveBehavior: fail`)                                                                                                       |

Only `confirmed` findings can fail the policy; `suspected` findings never do. `unknown`, `timeout` and `unsupported` results are never counted as success: with `warn` or `ignore` they keep the exit code at `0` but the verdict stays `pass_with_warnings` and the reasons list each one.

`veritas improve` and `veritas test replay` use the same codes with command-specific meanings, described below.

## Verdicts

Commands that run stages (`discover`, `analyze`, `mutate`, `prove`, `run`, `replay`) end with a policy verdict, recorded in `run.json`:

| Verdict              | Exit code | When                                                                                                                   |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pass`               | `0`       | No findings to review and nothing inconclusive                                                                         |
| `pass_with_warnings` | `0`       | Findings to review, confirmed violations reported as warnings by policy, or inconclusive results under `warn`/`ignore` |
| `policy_failure`     | `1`       | A confirmed violation with `confirmedViolation: fail`, or a policy threshold missed                                    |
| `tool_error`         | `3`       | A stage ended with `error` or `failed`                                                                                 |
| `inconclusive`       | `4`       | Inconclusive stages or claims with `inconclusiveBehavior: fail`                                                        |

The checks run in this order: thresholds and confirmed violations first, then tool errors, then inconclusive results. A run with both a confirmed violation and a failed stage is therefore a `policy_failure`.

## Environment variables

| Variable                              | Effect                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `VERITAS_DEBUG=1`                     | Same as `--debug`                                                                                                                  |
| `VERITAS_ACTOR`                       | Who records a decision or approves a plan, when `--actor` is not given (before the git `user.name`)                                |
| `VERITAS_SANDBOX_NODE`                | A Node.js 25+ executable for running project code with network access blocked                                                      |
| `VERITAS_CACHE_KEY_FILE`              | Location of the key that signs cache entries (default `~/.cache/veritas/cache-key`, `%LOCALAPPDATA%\veritas\cache-key` on Windows) |
| `CI`                                  | Any value other than an explicit false value makes `improve --apply` refuse to run                                                 |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Credentials for the `claude` and `openai` LLM providers (see [LLM providers](/guide/llm-providers))                                |

## Commands and options

The rest of this section is generated from the CLI itself, so it always matches the installed version.

<!--@include: ./_generated/cli.md-->

## Notes by command

### Setup: `init`, `doctor`

`init` detects the package manager, `tsconfig.json`, source and test globs, and writes `.veritas/config.json`. It refuses to overwrite an existing configuration without `--force`, and fails with `VITEST_NOT_FOUND` when the project does not use Vitest. `doctor` lists each capability (`node`, `git`, `package_manager`, `typescript`, `vitest`, `mutator`, `fast_check`, `z3`, `lean`, `llm`, `network`, `sandbox`) with its state, and which features each one affects. It reads only the login state of LLM CLIs, never account details.

### Stages: `discover`, `analyze`, `mutate`, `prove`, `run`

Each command runs a fixed list of stages; dependencies run first.

| Command                  | Stages                                            | Network by default                   |
| ------------------------ | ------------------------------------------------- | ------------------------------------ |
| `discover`               | discover                                          | Sources enabled in the configuration |
| `analyze`                | index, discover, spec, map, assess                | None (offline)                       |
| `mutate`                 | index, discover, spec, map, mutate, assess        | None (offline)                       |
| `prove`                  | index, discover, spec, map, prove, assess, report | None (offline)                       |
| `run --profile quick`    | index, discover, spec, map, assess, report        | Sources enabled in the configuration |
| `run --profile standard` | quick + mutate                                    | Sources enabled in the configuration |
| `run --profile deep`     | standard + pbt, prove                             | Sources enabled in the configuration |

`--offline` guarantees that Veritas itself makes no network request (no GitHub or web sources, no LLM). The project's own tests, which mutation testing runs, are not restricted by it; see [Untrusted repositories](/guide/untrusted-repositories). Report files (`report.json`, `report.md`, `report.html`, `report.sarif`) are written only by commands that include the report stage.

`--since <ref>` limits mutation testing to the change since a git ref; without it, `mutation.mode: "diff"` still runs every mutant in scope and says so in the stage messages. `--include-proposed` also verifies properties nobody has accepted yet; their results stay `suspected`.

`prove --engine lean` uses Lean 4 through Lake (installed separately); the default is Z3. `mutate --import <file>` normalizes an existing mutation-testing-elements report instead of running mutator, and cannot be combined with `--kill-matrix`.

### Specifications: `spec`

`spec accept` and `spec reject` append a decision to `.veritas/approvals.json` with the actor, time and reason. The actor comes from `--actor`, then `VERITAS_ACTOR`, then the git `user.name`. A decision applies to the property version it was made for. Nothing promotes a property to `accepted` except such a decision. See [Specifications](/guide/specifications).

### Property-based tests: `test`

`test generate` writes Vitest and fast-check test files under `.veritas/generated-tests/` and never runs them. `test replay <pbt-id>` re-runs a recorded property-based test with its seed, run count and shrink path; it exits `0` when the recorded result is reproduced and `4` when it is not.

### Improving tests: `improve`

`improve` defaults to a dry run that changes no project file. It prints a plan id and an approval token; applying needs `--apply --plan <id> --approve <token>` and is refused in CI (`IMPROVE_APPLY_IN_CI`).

| Exit code | `improve` outcome                                                |
| --------- | ---------------------------------------------------------------- |
| `0`       | Plan ready (dry run) or tests improved (apply)                   |
| `1`       | Blocked                                                          |
| `2`       | Invalid plan id or token, or applying in CI                      |
| `3`       | Tool error                                                       |
| `4`       | No safe improvement, or a specification decision is needed first |

See [Improving tests](/guide/improving-tests).

### Results: `report`, `explain`, `replay`

`report` prints the latest run (or `--run <run-id>`) as `text` (the default), `json`, `markdown`, `html` or `sarif`, redacted. `explain <finding-id>` prints the evidence chain of a finding: quoted sources, properties, tests, assessments, mutants and solver claims. `replay <run-id>` re-runs a recorded run with its stages and options. A replay is always offline: network sources and LLM extraction are not repeated.
