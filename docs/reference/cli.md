# CLI reference

The commands and options of `veritas`, its exit codes and verdicts, the environment variables it reads, and its JSON output. The commands that run the pipeline (`discover`, `analyze`, `mutate`, `prove`, `run` and `replay`) write their results to `.veritas/runs/<run-id>/`; the files are described in [Reports and artifacts](/reference/reports).

```bash
veritas [global options] <command> [options]
```

```bash
veritas init --yes
veritas run --profile standard
veritas report --format html > report.html
veritas explain F-0b43c88cc3a6
```

## Exit codes

| Code | Meaning                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. The verdict can still be `pass_with_warnings`                                                                                                           |
| `1`  | Policy failure: a confirmed specification violation with `policy.confirmedViolation: fail`, or a missed `policy.maxNewSurvivors` or `policy.minPropertyCoverage` |
| `2`  | User error: invalid arguments, a missing or invalid configuration, an unknown id, or a refused operation                                                         |
| `3`  | Tool error: a stage failed, or a solver or child process crashed                                                                                                 |
| `4`  | Inconclusive results with `policy.inconclusiveBehavior: fail`                                                                                                    |

Exit code `1` has two causes. One is a confirmed specification violation (a finding of kind `spec_implementation_mismatch`, `counterexample` or `spec_violation_candidate` with certainty `confirmed`) while `policy.confirmedViolation` is `fail`. The other is a missed `policy.maxNewSurvivors` or `policy.minPropertyCoverage`. Suspected findings and other confirmed findings, such as a surviving mutant, are reported but do not fail the run.

`unknown`, `timeout` and `unsupported` results never count as success: with `policy.inconclusiveBehavior` set to `warn` or `ignore`, the exit code is `0`, but the verdict is `pass_with_warnings` and the reasons list each result.

`veritas improve` and `veritas test replay` give some codes a command-specific meaning; see [Notes by command](#notes-by-command).

## Verdicts

Commands that run stages (`discover`, `analyze`, `mutate`, `prove`, `run`, `replay`) end with a verdict, which is also recorded in `run.json`.

| Verdict              | Exit code | When                                                                                                                                         |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`               | `0`       | No findings to review and no inconclusive results                                                                                            |
| `pass_with_warnings` | `0`       | Findings to review, confirmed violations reported as warnings (`confirmedViolation: warn`), or inconclusive results under `warn` or `ignore` |
| `policy_failure`     | `1`       | A confirmed violation with `confirmedViolation: fail`, or a missed policy threshold                                                          |
| `tool_error`         | `3`       | A stage ended with `error` or `failed`                                                                                                       |
| `inconclusive`       | `4`       | Inconclusive stages or claims with `inconclusiveBehavior: fail`                                                                              |

When several apply, the first one in this order wins: `policy_failure`, `tool_error`, `inconclusive`.

## JSON output

With the global `--json` option, stdout contains exactly one JSON value and nothing else; progress messages and logs go to stderr. Help and the version are JSON too (`{"status":"ok","help":"..."}`, `{"status":"ok","version":"..."}`), and so are errors:

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

`code` identifies the error (for example `CONFIG_MISSING`, `NO_RUN`, `ROOT_NOT_FOUND`) and `hint` suggests what to do. `--log-format json` changes only the stderr log, to one JSON object per line.

`veritas report --json` is the same as `veritas report --format json`. `--json` together with another `--format` is a user error (`FORMAT_CONFLICT`).

## Environment variables

| Variable                              | Effect                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `VERITAS_DEBUG=1`                     | Same as `--debug`                                                                                                          |
| `VERITAS_ACTOR`                       | Name recorded for spec decisions and approvals when `--actor` is not given; without it, the git `user.name` is used        |
| `VERITAS_SANDBOX_NODE`                | Path of a Node.js 25 or later used to run project code with network access blocked                                         |
| `VERITAS_CACHE_KEY_FILE`              | Key file that signs cache entries (default `~/.cache/veritas/cache-key`, or `%LOCALAPPDATA%\veritas\cache-key` on Windows) |
| `CI`                                  | When set to anything other than a false value, `improve --apply` refuses to run                                            |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Credentials for the `claude` and `openai` LLM providers (see [LLM providers](/guide/llm-providers))                        |

## Commands and options

<!--@include: ./_generated/cli.md-->

## Notes by command

### `init` and `doctor`

`init` detects the package manager, `tsconfig.json` and the source and test globs, and writes `.veritas/config.json`. The package manager comes from the nearest lockfile committed to git, looking from the project up to the root of the repository. Without one, it comes from the `packageManager` field of the nearest `package.json` that has it, and only then from the nearest lockfile that is on disk but not committed. So a `pnpm-lock.yaml` left behind by running pnpm once in an npm project does not make it a pnpm project, and an untracked `package-lock.json` in one workspace package does not hide the committed lockfile of the workspace. The source globs cover `src/` (or `lib/`) of the root and of every workspace package declared in `pnpm-workspace.yaml` (`packages:`) or in the `workspaces` field of `package.json` (literal paths and a trailing `*`). Besides `*.test.*` and `*.spec.*`, files named `test.ts` (and `.tsx`, `.js`, `.mjs`) and files under `__tests__/` become test globs when such a file uses the test runner (imports from `vitest` or `@jest/globals`, or, with Jest, calls its global `describe`, `it` or `test`). It also finds the test runner, Vitest or Jest, writes it to `analysis.testFramework` and prints why it chose it; see [Getting started](/guide/getting-started#create-the-configuration). It does not overwrite an existing configuration unless you pass `--force`, and fails with `VITEST_NOT_FOUND` when the project uses neither runner.

`doctor` lists each capability (`node`, `git`, `package_manager`, `typescript`, the test runner (`vitest` or `jest`), `mutator`, `fast_check`, `z3`, `lean`, `llm`, `network`, `sandbox`), its state, and the features it affects. A feature is degraded when an optional capability is missing, or when it needs mutation testing that is experimental with the project's test runner (Jest); it then lists `mutator` under `partial`. Mutator, fast-check and Z3 are taken from the project when it installs them, and otherwise from the copies installed with Veritas; `doctor` shows which. For LLM CLIs, it checks only whether you are logged in.

### Commands that run stages

| Command                  | Stages                                            | Network access                               |
| ------------------------ | ------------------------------------------------- | -------------------------------------------- |
| `discover`               | discover                                          | Sources and LLM enabled in the configuration |
| `analyze`                | index, discover, spec, map, assess                | None                                         |
| `mutate`                 | index, discover, spec, map, mutate, assess        | None                                         |
| `prove`                  | index, discover, spec, map, prove, assess, report | None                                         |
| `run --profile quick`    | index, discover, spec, map, assess, report        | Sources and LLM enabled in the configuration |
| `run --profile standard` | quick + mutate                                    | Sources and LLM enabled in the configuration |
| `run --profile deep`     | standard + pbt, prove                             | Sources and LLM enabled in the configuration |
| `replay`                 | the stages of the recorded run                    | None                                         |

`--offline` makes Veritas itself send no network request: no GitHub or web sources and no LLM. It does not restrict the project's own tests, which mutation testing runs; to keep those off the network, see [Untrusted repositories](/guide/untrusted-repositories).

Only commands with the report stage (`run`, `prove`, and `replay` of such a run) write report files to the run directory. `veritas report` renders a report from any run.

`--since <ref>` limits mutation testing to code changed since a git ref. `--include-proposed` also checks properties that are not accepted; findings from them are at most `suspected`.

`prove --engine lean` uses Lean 4 with Lake, which you install separately; `--engine both` adds Lean proofs to the Z3 checks; without `--engine`, `prove` uses `formal.backend` (Z3 by default). `mutate --import <file>` reads an existing mutation-testing-elements report instead of running mutator, and cannot be combined with `--kill-matrix`.

### `spec`

`spec accept` and `spec reject` add a decision with the actor, time and reason to `.veritas/approvals.json`. The actor is `--actor`, else `VERITAS_ACTOR`, else the git `user.name`. A decision applies to the version of the property it was made for; if the property changes, decide again. Only a recorded decision makes a property `accepted`. See [Specifications](/guide/specifications).

### `test`

`test generate` writes fast-check test files, in the syntax of the project's test runner, to `.veritas/generated-tests/` and does not run them. `test replay <pbt-id>` re-runs a recorded property-based test with the same seed, number of runs and shrink path. It exits with `0` when it reproduces the recorded result and `4` when it does not.

### `improve`

Without `--apply`, `improve` is a dry run that changes no project file and prints a plan id and an approval token. To apply the plan, run `improve --apply --plan <id> --approve <token>`. Applying is refused in CI (`IMPROVE_APPLY_IN_CI`).

| Exit code | Outcome                                                          |
| --------- | ---------------------------------------------------------------- |
| `0`       | Plan ready (dry run), or tests improved (apply)                  |
| `1`       | Blocked                                                          |
| `2`       | Invalid plan id or token, or applying in CI                      |
| `3`       | Tool error                                                       |
| `4`       | No safe improvement, or a specification decision is needed first |

See [Improving tests](/guide/improving-tests).

### `report`, `explain` and `replay`

`report` prints the latest run, or the run given with `--run`, as `text` (the default), `json`, `markdown`, `html` or `sarif`. `explain <finding-id>` prints the evidence behind a finding: quoted sources, properties, tests, assessments, mutants and solver claims. `replay <run-id>` runs a recorded run again with the same stages and options, always offline.
