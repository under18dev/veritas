# GitHub Action

The Veritas action runs the same engine as the CLI, offline, on a GitHub Actions runner. It is defined in [`packages/github-action/action.yml`](https://github.com/under18dev/veritas/blob/main/packages/github-action/action.yml) and runs on the `node24` runtime. For how to fit it into a CI setup, see [CI and GitHub Action](/guide/ci).

## Example workflow

The recommended workflow is [`packages/github-action/examples/pull-request.yml`](https://github.com/under18dev/veritas/blob/main/packages/github-action/examples/pull-request.yml):

```yaml
name: veritas
on:
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          # Node.js 25+ on PATH runs project code without network access.
          node-version: 26
      - run: pnpm install --frozen-lockfile
      - uses: veritas/github-action@v1
        with:
          profile: standard
      - uses: actions/upload-artifact@v4
        with:
          name: veritas-runs
          path: .veritas/runs
          retention-days: 14
```

What each part is for:

- `permissions: contents: read` and `persist-credentials: false` leave the job with a read-only token that is not stored in the checkout. Code from the pull request runs in this job, so it must not be able to push or read secrets.
- The action itself runs on `node24`. Set up Node.js 25 or later in the job (the example uses 26): property-based tests and counterexample replay call project code only under a Node.js that can block its network access. Without one, those results are not produced and stay inconclusive, unless `sandbox.allowNetworkWithoutIsolation` is set.
- Install the project's dependencies before the action: mutation testing runs the project's own Vitest suite.
- Upload `.veritas/runs` as an artifact with a retention period, so that the evidence of a run can be inspected and the run replayed locally.

Two adjustments are usually needed: the `pnpm install` step assumes pnpm is available on the runner (for example through `pnpm/action-setup`, or use your package manager's install command), and the `uses:` line must point to where you get the action from.

The project must contain a committed `.veritas/config.json` (create it with `veritas init`); without it the action fails with `CONFIG_MISSING` (exit code 2).

## Inputs

| Input               | Default    | Meaning                                                                                                    |
| ------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`, `standard` or `deep`; the same stages as `veritas run --profile`                                  |
| `working-directory` | `.`        | Project directory, relative to the workspace. A path outside the checked-out repository is refused         |
| `since`             | `""`       | Base commit for incremental checks. Empty: the pull request's base SHA, or the previous commit of a push   |
| `inconclusive`      | `warn`     | `warn`, `fail` or `ignore`. With `fail`, any inconclusive result makes the verdict `inconclusive` (exit 4) |
| `summary`           | `"true"`   | Write a step summary; `"false"` turns it off                                                               |

The run is always offline: no GitHub or web sources and no LLM, whatever the configuration says. The `inconclusive` input can only make the result stricter. If the configuration already has `policy.inconclusiveBehavior: "fail"`, inconclusive results end with exit code 4 even when the input is `warn`.

## Outputs

| Output               | Meaning                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `verdict`            | `pass`, `pass_with_warnings`, `policy_failure`, `tool_error` or `inconclusive`; also `skipped` for a documentation-only change |
| `exit-code`          | The exit code of the step                                                                                                      |
| `run-id`             | The run id; empty when nothing ran                                                                                             |
| `confirmed-findings` | Number of findings with certainty `confirmed`                                                                                  |
| `report-path`        | Path of the run's `run.json`, relative to `working-directory`, with `/` separators; empty when nothing ran                     |
| `from-fork`          | `true` for a pull request from a fork, otherwise `false`                                                                       |

A later step can read them through the step's `id`:

```yaml
- uses: veritas/github-action@v1
  id: veritas
  with:
    profile: standard
    inconclusive: fail
- if: always()
  run: echo "verdict ${{ steps.veritas.outputs.verdict }}, run ${{ steps.veritas.outputs.run-id }}"
```

## Exit codes

| Code | Meaning                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Passing, including warnings, documentation-only changes that were skipped, and degraded projects (below) under a `warn` policy |
| `1`  | Confirmed policy failure                                                                                                       |
| `2`  | Invalid or unsafe invocation: a refused event, an invalid `working-directory`, a missing or invalid configuration              |
| `3`  | Tool error, including an unsupported event                                                                                     |
| `4`  | Inconclusive with the `fail` policy                                                                                            |

The verdicts are the same as the CLI's (see [CLI reference](/reference/cli#verdicts)). A passing check is evidence about the configured checks and bounds, not a formal proof that the tests or the implementation are correct.

## Events

| Event                                                  | Behaviour                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pull_request`                                         | Incremental against the pull request's base SHA; works for pull requests from forks |
| `push`                                                 | Incremental against the commit before the push                                      |
| `workflow_dispatch`, `schedule`, `repository_dispatch` | Full run, no base commit                                                            |
| `pull_request_target`                                  | Refused (exit 2)                                                                    |
| `workflow_run` for a pull request from a fork          | Refused (exit 2)                                                                    |
| Any other event                                        | Error (exit 3)                                                                      |

The changed files are listed with `git diff <since>...HEAD`, so the base commit must be in the checkout (for example `fetch-depth: 0` on `actions/checkout`). If it is not, the action cannot list the changed files and does not apply the documentation-only skip below.

## Skipped and degraded runs

When every changed file is Markdown, under `docs/`, or an image (`png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `bmp`, `ico`), the action skips the analysis: `verdict` is `skipped` and the exit code is `0`.

When the project has no `package.json`, or Vitest is unavailable, the action does not run and reports `verdict: inconclusive` with exit code `0` under `warn` or `ignore`, and `4` under `fail`. The step summary says why.

## Step summary

Unless `summary` is `"false"`, the step summary lists the verdict, the exit code, the run id, whether the pull request comes from a fork, the number of findings by certainty, and up to 20 findings with their ids. For the details, run `veritas explain <finding-id>` locally. Each run records what `veritas replay <run-id>` needs to reproduce it.

## Fork safety

Pull requests from forks are supported through the `pull_request` event, which GitHub runs without secrets and with a read-only token. The action itself never reads a token and never enables network sources.

`pull_request_target`, and `workflow_run` triggered by a fork, are refused: they combine a privileged workflow context with code from the pull request. The workflow should grant only `contents: read` and check out with `persist-credentials: false`, as in the example. The action package contains a checker for these rules (`checkWorkflowSafety`), which Veritas's own tests apply to the example workflow:

- a `pull_request` workflow declares top-level `permissions`, and they are read-only (`contents: read`, everything else `none`);
- no job of a pull request workflow references `secrets.*` or the GitHub token;
- every `actions/checkout` step sets `persist-credentials: false`;
- a `pull_request_target` workflow never checks out the pull request head SHA.

## Redaction

Outputs, the step summary and every artifact are redacted: common token formats (GitHub, Anthropic, OpenAI, AWS, Slack, private keys, credentials in URLs and `Authorization` headers) and the values of environment variables whose names look secret are replaced with `[REDACTED]`. See [Reports and artifacts](/reference/reports#redaction).
