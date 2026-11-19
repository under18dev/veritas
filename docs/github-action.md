# GitHub Action

The Veritas action runs the same offline engine used by the CLI. A recommended workflow is in `packages/github-action/examples/pull-request.yml`.

Inputs are `profile` (`quick`, `standard`, or `deep`), `working-directory`, `since`, `inconclusive` (`warn`, `fail`, or `ignore`), and `summary`. The pull request base SHA is used for `since` when it is not supplied. Outputs are `verdict`, `exit-code`, `run-id`, `confirmed-findings`, and `report-path`.

Exit code 0 is a passing result, including warnings and degraded unsupported projects; 1 is a confirmed policy failure; 2 is an invalid or unsafe invocation; 3 is a tool error; and 4 is inconclusive when the policy is `fail`. Verdicts distinguish `pass`, `pass_with_warnings`, `policy_failure`, `tool_error`, and `inconclusive`.

Fork pull requests are supported through the `pull_request` event. The action never reads a token or enables network sources, and the workflow should grant only `contents: read` and disable checkout credentials. `pull_request_target` is refused because it combines privileged workflow context with untrusted pull request code.

Changes consisting only of Markdown, `docs/`, or image files are skipped. Runs are stored under `.veritas/runs`; upload them as an artifact with a retention policy such as 14 days. Reports redact token-shaped values and secret environment values.

Each run records `veritas replay <run-id>` for local reproduction. A passing gate is evidence about the configured checks and bounds, not a formal proof that the tests or implementation are correct.
