# CI and GitHub Action

Veritas runs in CI the same way it runs locally: it writes a run directory, prints a verdict and exits with a code your CI system can act on. This page covers the GitHub Action, the policies that decide the exit code, and plain CLI use in any CI system.

## What to commit

CI needs the configuration and, if you use accepted properties, the decisions. Commit `.veritas/config.json` and `.veritas/approvals.json`, and ignore the rest:

```text
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

Without `.veritas/config.json`, `veritas run` stops with `CONFIG_MISSING` (exit code `2`).

## Exit codes and policies

| Exit code | Verdict                                    | Typical CI meaning     |
| --------- | ------------------------------------------ | ---------------------- |
| `0`       | `pass`, `pass_with_warnings`               | Pass                   |
| `1`       | `policy_failure`                           | Fail                   |
| `2`       | Configuration or usage error               | Fix the workflow       |
| `3`       | `tool_error`                               | Infrastructure problem |
| `4`       | `inconclusive` (only with a `fail` policy) | Your choice            |

The policy lives in `.veritas/config.json`:

```json
{
  "policy": {
    "confirmedViolation": "fail",
    "inconclusiveBehavior": "warn",
    "maxNewSurvivors": 0,
    "minPropertyCoverage": 0.8
  }
}
```

| Setting                       | Values (default)                    | Effect                                                                                                                                                                                             |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.confirmedViolation`   | `fail` or `warn` (`fail`)           | Whether a confirmed specification violation exits `1`                                                                                                                                              |
| `policy.inconclusiveBehavior` | `fail`, `warn` or `ignore` (`warn`) | `fail` turns inconclusive results (undecided claims, partial or skipped stages) into exit `4`. With `warn` and `ignore` they are listed, and the verdict is never better than `pass_with_warnings` |
| `policy.maxNewSurvivors`      | integer (unset)                     | Exit `1` when more mutants survive in this run's scope than allowed. With `--since`, the scope is the change. Inconclusive when the run has no mutation results                                    |
| `policy.minPropertyCoverage`  | 0 to 1 (unset)                      | Exit `1` when the share of accepted properties with at least one `meaningful_with_evidence` test is lower. Inconclusive when there is no accepted property                                         |

Suspected findings never fail the policy. A threshold that cannot be measured is inconclusive, never passed.

## Pull requests: `--since`

On a pull request, limit mutation testing to what changed:

```bash
veritas run --profile standard --offline --since origin/main
```

`--since <ref>` needs the ref in the clone, so fetch the full history (`fetch-depth: 0` with `actions/checkout`). `maxNewSurvivors` then counts survivors in the changed code only. Mutants outside the change are left out on purpose, and this does not make the mutation stage partial.

## The GitHub Action

The action in `packages/github-action` runs the same engine as the CLI, offline. It runs on the `node24` runtime; set up Node.js 25 or later in the job (the example uses 26), so property-based tests and counterexample replay can run project code without network access. Without it they are not run and the results stay inconclusive.

The workflow in `packages/github-action/examples/pull-request.yml`:

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

::: warning
The example refers to the action as `veritas/github-action@v1`. Check the [GitHub Action reference](/reference/github-action) for how to reference the action in your workflow. If you cannot use the action, the [CLI workflow](#plain-cli-on-github-actions) below gives the same results with the npm package.
:::

### Inputs and outputs

| Input               | Default    | Meaning                                                                                                        |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`, `standard` or `deep`                                                                                  |
| `working-directory` | `.`        | Project directory                                                                                              |
| `since`             | (empty)    | Base SHA. On `pull_request`, the base SHA of the pull request is used when empty; on `push`, the previous head |
| `inconclusive`      | `warn`     | `warn`, `fail` or `ignore`. When not set, `policy.inconclusiveBehavior` from the configuration applies         |
| `summary`           | `true`     | Write a step summary                                                                                           |

| Output               | Contents                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `verdict`            | `pass`, `pass_with_warnings`, `policy_failure`, `tool_error`, `inconclusive`, or `skipped` |
| `exit-code`          | The Veritas exit code                                                                      |
| `run-id`             | The run ID                                                                                 |
| `confirmed-findings` | Number of confirmed findings                                                               |
| `report-path`        | Path to the run's `run.json`, relative to the workspace                                    |
| `from-fork`          | `true` for a pull request from a fork                                                      |

A change that consists only of Markdown files, files under `docs/` or images is skipped with verdict `skipped` and exit code `0`. Each run records `veritas replay <run-id>`, so you can reproduce it locally from the uploaded artifact.

### Fork pull requests

The action is safe to run on pull requests from forks through the `pull_request` event:

- It never reads a token and never enables network sources.
- Grant only `contents: read` and check out with `persist-credentials: false`, as in the example.
- It refuses `pull_request_target`, and `workflow_run` for fork pull requests, because those combine a privileged context with untrusted code.
- Reports redact token-shaped values and secret environment values.

The project's tests still run (mutation testing executes them). On a fork pull request they run without secrets, the same as any test job.

### Artifacts

Runs are stored under `.veritas/runs/`. Upload them with a retention period, as the example does with 14 days. The run directory contains the reports (`report.html`, `report.md`, `report.sarif`), all JSON artifacts and `trace.jsonl`.

## SARIF and code scanning

Every run writes `report.sarif` (SARIF 2.1.0); `veritas report --format sarif` prints it for the latest run. To show findings in GitHub code scanning, upload it with `github/codeql-action/upload-sarif`. That step needs `security-events: write`, which workflows on fork pull requests do not get, so run the upload only for pull requests from the same repository or for pushes.

## Plain CLI on GitHub Actions

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
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 26
      - run: npm ci
      - run: npx veritas run --profile standard --offline --since "${{ github.event.pull_request.base.sha }}"
      - run: npx veritas report --format markdown >> "$GITHUB_STEP_SUMMARY"
        if: always()
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: veritas-runs
          path: .veritas/runs
          retention-days: 14
```

This assumes `@under18dev/veritas` is a dev dependency of the project. The `run` step fails the job with the Veritas exit code.

## Other CI systems

Any CI system that runs Node.js can run the CLI. The pattern is the same:

```bash
npm ci
npx veritas run --profile standard --offline --since "$BASE_SHA"
status=$?
npx veritas report --format sarif > veritas.sarif
npx veritas report --format html > veritas.html
exit $status
```

- Use `--json` if you need the result as data: stdout then holds only JSON, logs go to stderr.
- Keep `.veritas/runs/` as a build artifact.
- `veritas improve --apply` is refused whenever the `CI` environment variable is set. Planning (`veritas improve --dry-run`) works.
- `--offline` stops Veritas itself from making network requests; the project's tests can still use the network unless the job has none.
