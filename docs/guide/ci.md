# CI and GitHub Action

Run Veritas on pull requests with the GitHub Action or the CLI, and choose which results fail the build.

Before you start, commit `.veritas/config.json` (and `.veritas/approvals.json` if you have accepted properties); [Getting started](/guide/getting-started#find-the-results) has a matching `.gitignore`. Without the configuration, `veritas run` stops with `CONFIG_MISSING` (exit code `2`).

## Add the GitHub Action

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

- Reference the action as `under18dev/veritas/packages/github-action@v<version>`. It runs the `@under18dev/veritas-github-action` package of the same version with the Node.js set up in the job, offline.
- Set up Node.js 25 or later so that property-based tests and counterexample replay can run your functions with network access blocked. With an older Node.js those checks do not run and their results are inconclusive.
- `fetch-depth: 0` makes the base commit available for comparison.
- `pnpm/action-setup` is needed only if your project uses pnpm.
- Upload `.veritas/runs/` to keep the reports, the JSON artifacts and `trace.jsonl`. Each run can be reproduced locally with `veritas replay <run-id>`.

### Inputs

| Input               | Default    | Meaning                                                                                              |
| ------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `profile`           | `standard` | `quick`, `standard` or `deep`                                                                        |
| `working-directory` | `.`        | Project directory, relative to the workspace                                                         |
| `since`             | (empty)    | Base SHA. When empty: the pull request base on `pull_request`, the previous head on `push`           |
| `inconclusive`      | (empty)    | `warn`, `fail` or `ignore`. When empty, `policy.inconclusiveBehavior` from the configuration applies |
| `summary`           | `true`     | Write a step summary                                                                                 |

### Outputs

| Output               | Contents                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `verdict`            | `pass`, `pass_with_warnings`, `policy_failure`, `tool_error`, `inconclusive` or `skipped` |
| `exit-code`          | The Veritas exit code                                                                     |
| `run-id`             | The run ID                                                                                |
| `confirmed-findings` | Number of confirmed findings                                                              |
| `report-path`        | Workspace-relative path of the run's `run.json`; the reports are in the same directory    |
| `from-fork`          | `true` for a pull request from a fork                                                     |

A change that touches only Markdown files, files under `docs/` or images is skipped with verdict `skipped` and exit code `0`.

### Pull requests from forks

On the `pull_request` event, the action:

- reads no token and enables no network source;
- refuses `pull_request_target`, and `workflow_run` for fork pull requests, because they run untrusted code with elevated permissions;
- redacts token-shaped values and secret environment values in reports.

Grant only `contents: read` and check out with `persist-credentials: false`, as in the example. Mutation testing runs the pull request's tests, which on a fork pull request run without secrets like any other test job.

## Choose what fails the build

| Exit code | Verdict                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | `pass`, `pass_with_warnings`. From the action also `skipped` (documentation-only change), and `inconclusive` when the project cannot be analysed (no `package.json`, or no test runner) and the policy is not `fail` |
| `1`       | `policy_failure`: a confirmed specification violation, or a failed `maxNewSurvivors` or `minPropertyCoverage` threshold                                                                                              |
| `2`       | Configuration or usage error                                                                                                                                                                                         |
| `3`       | `tool_error`                                                                                                                                                                                                         |
| `4`       | `inconclusive`, only when the inconclusive policy is `fail`                                                                                                                                                          |

Set the policy in `.veritas/config.json`:

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

| Setting                       | Values (default)                  | Effect                                                                                                                                                                   |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policy.confirmedViolation`   | `fail`, `warn` (`fail`)           | Exit `1` on a confirmed specification violation                                                                                                                          |
| `policy.inconclusiveBehavior` | `fail`, `warn`, `ignore` (`warn`) | `fail` turns inconclusive results (undecided claims, partial or skipped stages) into exit `4`; otherwise they are listed and the verdict is at best `pass_with_warnings` |
| `policy.maxNewSurvivors`      | integer (unset)                   | Exit `1` when more mutants survive in the run's scope; with `--since`, the scope is the change. Inconclusive without mutation results                                    |
| `policy.minPropertyCoverage`  | 0 to 1 (unset)                    | Exit `1` when a smaller share of accepted properties has a `meaningful_with_evidence` test. Inconclusive when no property is accepted or the run has no test assessments |

Suspected findings never fail the build, and a threshold that cannot be measured is inconclusive.

## Check only the change

```bash
veritas run --profile standard --offline --since origin/main
```

`--since <ref>` limits mutation testing to code changed since the ref, which must exist in the clone (`fetch-depth: 0`). Mutants outside the change are not run and do not make the mutation stage partial.

## Show findings in code scanning

`veritas run`, `veritas prove` and the action write `report.sarif` (SARIF 2.1.0) to the run directory when `reports.formats` includes `sarif`, which it does by default; `veritas report --format sarif` prints it for the latest run. Upload it with `github/codeql-action/upload-sarif`. That step needs `security-events: write`, which workflows on fork pull requests do not receive, so run it only for pushes and same-repository pull requests.

## Use the CLI in a GitHub workflow

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

This requires `@under18dev/veritas` in the project's dev dependencies. The `veritas run` step fails the job through its exit code.

## Verify declared properties in CI

Properties you [declare in the configuration](/guide/verification#declare-a-property) can be checked on every change, so a pull request that breaks one fails. The Veritas repository does this with its own run policy.

### How Veritas checks itself

The `self-verification` job in the repository's `.github/workflows/ci.yml` runs on Ubuntu:

1. It installs Lean with elan and builds the packages. Z3 is bundled.
2. `veritas --json prove --engine both` at the repository root. The configuration declares the invariants of the run policy (`packages/core/src/policy-decision.ts`), and `.veritas/approvals.json` holds the maintainer's decisions. A non-zero exit code fails the job.
3. `node scripts/check-self-verification.mjs` checks the run. It fails unless every declared property is accepted, proven within the model by Z3 with the result checked against the function in JavaScript (`replay confirmed`), and kernel-checked by Lean. `unknown`, `timeout`, `unsupported`, `semantic_mismatch` and `error` all fail, as does a run of another commit, configuration, source or declaration version.
4. A negative control: prove runs in a copy of `fixtures/declared-properties`, which declares a deliberately false invariant. Prove must exit `1` (a confirmed violation), and the check must find a Z3 counterexample reproduced in JavaScript and no proof (`--expect-counterexample`). A solver or translator that proved everything would fail here.

The job caches no Veritas results: each workflow run starts without `.veritas/cache` and without earlier runs, so a stale result cannot pass. The runs are uploaded as the `self-verification-runs` artifact. Lean takes about a minute.

### Do the same in your repository

1. Declare the properties in `.veritas/config.json`, review them and record the decisions with `veritas spec accept D-<id> --reason "<why>"`. You can do this before the first run. Commit `.veritas/config.json` and `.veritas/approvals.json`.
2. Set `policy.confirmedViolation` and `policy.inconclusiveBehavior` to `fail`, so a counterexample exits `1` and any undecided result (`unknown`, `timeout`, `unsupported`) exits `4`.
3. Run prove and fail on its exit code. Install Lean only if you use `--engine both` or `lean`.
4. A property that is not accepted is not checked and does not change the exit code. To require that every declaration is accepted, check the list as well.

```yaml
- name: Install Lean (elan)
  run: |
    curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o elan-init.sh
    sh elan-init.sh -y --default-toolchain stable --no-modify-path
    echo "$HOME/.elan/bin" >> "$GITHUB_PATH"
- run: npx veritas --json prove --engine both
- name: Every declared property is accepted
  run: >-
    npx veritas spec list --json
    | jq -e '[.properties[] | select(.id | startswith("D-")) | select(.status != "accepted")] | length == 0'
```

Do not cache `.veritas/` between workflow runs. `scripts/check-self-verification.mjs` is part of the Veritas repository, not of the published packages; it shows the stricter checks you can add, such as requiring a Lean proof for every property.

## Use the CLI in other CI systems

```bash
npm ci
npx veritas run --profile standard --offline --since "$BASE_SHA"
status=$?
npx veritas report --format sarif > veritas.sarif
npx veritas report --format html > veritas.html
exit $status
```

- `--json` prints only JSON on stdout and logs on stderr.
- Keep `.veritas/runs/` as a build artifact.
- `veritas improve --apply` is refused when the `CI` environment variable is set to a value other than empty, `false` or `0`. `veritas improve --dry-run` works in CI.
- `--offline` stops Veritas from making network requests. Your tests keep whatever network access the job has.
