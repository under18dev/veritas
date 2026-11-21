# GitHub Action

The Veritas GitHub Action runs the same analysis as `veritas run`, offline. Below are an example workflow, how versions are pinned, the inputs and outputs, exit codes, supported events, and the rules that keep pull requests from forks safe. For how to fit it into a CI setup, see [CI and GitHub Action](/guide/ci).

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
          # The base commit is needed to compare against it and to skip documentation-only changes.
          fetch-depth: 0
          persist-credentials: false
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          # Node.js 25+ on PATH runs project code without network access.
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: under18dev/veritas/packages/github-action@v0.2.2
        with:
          profile: standard
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: veritas-runs
          path: .veritas/runs
          retention-days: 14
```

What each part is for:

- `permissions: contents: read` and `persist-credentials: false` leave the job with a read-only token that is not stored in the checkout. Code from the pull request runs in this job, so it must not be able to push or read secrets.
- `fetch-depth: 0` fetches the history, so that the base commit of the pull request is available. The action lists the changed files with `git diff <since>...HEAD` and limits mutation testing to the change.
- `pnpm/action-setup` and `pnpm install` install the project's dependencies: mutation testing runs the project's own Vitest suite. With another package manager, use its install command instead.
- `actions/setup-node` provides the Node.js the action runs with (see below). Use Node.js 25 or later (the example uses 26).
- `upload-artifact` with `if: always()` keeps `.veritas/runs` even when the Veritas step fails, so that the evidence of a failing run can be inspected and the run replayed locally. Set a retention period.

The analysis needs a committed `.veritas/config.json` (create it with `veritas init`); when the analysis runs without it, the action fails with `CONFIG_MISSING` (exit code 2). A documentation-only change ends before the configuration is read. A project that cannot be analysed (no `package.json` or no Vitest) does not need the configuration either: if one is present and valid, it only supplies `policy.inconclusiveBehavior`.

## Versions and Node.js

The action is referenced by its path in the Veritas repository and a release tag: `under18dev/veritas/packages/github-action@v<version>`. Each tag's `action.yml` runs the published npm package of exactly that version, `npx --yes @under18dev/veritas-github-action@<version>`, so the tag you pin is the Veritas version that runs. To upgrade, change the tag.

Because the action is a composite action, it runs on the Node.js that the job set up with `actions/setup-node`, not on a runtime bundled with the action. Property-based tests and counterexample replay call project code only under a Node.js 25 or later, which can block its network access. With an older Node.js, those results are not produced and stay inconclusive, unless `sandbox.allowNetworkWithoutIsolation` is set. The step downloads the package from the npm registry when it starts; the analysis itself is offline.

## Inputs

| Input               | Default    | Meaning                                                                                                         |
| ------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`, `standard` or `deep`; the same stages as `veritas run --profile`                                       |
| `working-directory` | `.`        | Project directory, relative to the workspace. A path outside the checked-out repository is refused              |
| `since`             | `""`       | Base commit for incremental checks. Empty: the pull request's base SHA, or the commit before a push             |
| `inconclusive`      | `""`       | `warn`, `fail` or `ignore`. Empty: `policy.inconclusiveBehavior` from the configuration, else `warn`. See below |
| `summary`           | `"true"`   | Write a step summary; `"false"` turns it off                                                                    |

The run is always offline: no GitHub or web sources and no LLM, whatever the configuration says. How `inconclusive` applies:

- When the action cannot run the analysis (no `package.json`, or Vitest unavailable), it decides alone: `fail` gives exit code 4, `warn` and `ignore` give 0.
- After an analysis, `fail` turns any inconclusive result into the verdict `inconclusive` (exit code 4).
- `warn` or `ignore` cannot relax the configuration: with `policy.inconclusiveBehavior: "fail"` in the configuration, inconclusive results still end with exit code 4.

## Outputs

| Output               | Meaning                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict`            | `pass`, `pass_with_warnings`, `policy_failure`, `tool_error` or `inconclusive`; also `skipped` for a documentation-only change                                                                          |
| `exit-code`          | The exit code of the step                                                                                                                                                                               |
| `run-id`             | The run id; empty when nothing ran                                                                                                                                                                      |
| `confirmed-findings` | Number of findings with certainty `confirmed`                                                                                                                                                           |
| `report-path`        | Path of the run's `run.json`, relative to the workspace, with `/` separators. The reports (`report.json`, `report.md`, `report.html`, `report.sarif`) are in the same directory. Empty when nothing ran |
| `from-fork`          | `true` for a pull request from a fork, otherwise `false`                                                                                                                                                |

A later step can read them through the step's `id`. Add `if: always()` so that the step also runs when Veritas fails:

```yaml
- uses: under18dev/veritas/packages/github-action@v0.2.2
  id: veritas
  with:
    profile: standard
    inconclusive: fail
- if: always()
  run: echo "verdict ${{ steps.veritas.outputs.verdict }}, run ${{ steps.veritas.outputs.run-id }}"
```

## Exit codes

| Code | Meaning                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Passing, including warnings, documentation-only changes that were skipped, and degraded projects (below) unless `inconclusive` is `fail` |
| `1`  | Policy failure: a confirmed specification violation, or a missed policy threshold                                                        |
| `2`  | Invalid or unsafe invocation: a refused event, an invalid `working-directory`, a missing or invalid configuration                        |
| `3`  | Tool error, including an unsupported event                                                                                               |
| `4`  | Inconclusive with the `fail` policy                                                                                                      |

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

The changed files are listed with `git diff <since>...HEAD`, so the base commit must be in the checkout (`fetch-depth: 0`, as in the example). If it is not, the action cannot list the changed files and does not apply the documentation-only skip below.

## Skipped and degraded runs

When every changed file is Markdown, under `docs/`, or an image (`png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `bmp`, `ico`), the action skips the analysis: `verdict` is `skipped` and the exit code is `0`.

When the project has no `package.json`, or Vitest is unavailable, the action does not run and reports `verdict: inconclusive` with exit code `0` under `warn` or `ignore`, and `4` under `fail`. The step summary says why.

## Step summary

Unless `summary` is `"false"`, the step summary lists the verdict, the exit code, the run id, whether the pull request comes from a fork, the number of findings by certainty, and up to 20 findings with their ids. For the details, run `veritas explain <finding-id>` locally. Each run records what `veritas replay <run-id>` needs to reproduce it.

## Fork safety

Pull requests from forks are supported through the `pull_request` event, which GitHub runs without secrets and with a read-only token. The action itself never reads a token and never enables network sources.

`pull_request_target`, and `workflow_run` triggered by a fork, are refused: they combine a privileged workflow context with code from the pull request. Write the workflow so that it follows these rules, as the example does:

- a `pull_request` workflow declares top-level `permissions`, and they are read-only (`contents: read`, everything else `none`);
- no job of a pull request workflow references `secrets.*` or the GitHub token;
- every `actions/checkout` step sets `persist-credentials: false`;
- a `pull_request_target` workflow never checks out the pull request head SHA.

## Redaction

Outputs, the step summary and every artifact are redacted: common token formats (GitHub, Anthropic, OpenAI, AWS, Slack, private keys, credentials in URLs and `Authorization` headers) and the values of environment variables whose names look secret are replaced with `[REDACTED]`. See [Reports and artifacts](/reference/reports#redaction).
