# User guide

## 1. Set up

```bash
veritas init --yes     # writes .veritas/config.json (refuses to overwrite without --force)
veritas doctor         # shows which features are enabled, degraded or disabled, and why
```

`init` fails with `VITEST_NOT_FOUND` if the project does not use Vitest.

## 2. Run

```bash
veritas run --profile quick      # discovery, code and test analysis, assessment (no project code executed)
veritas run --profile standard   # + mutation testing
veritas run --profile deep       # + property-based tests and Z3 checks
```

Add `--include-proposed` to check properties that nobody has accepted yet. Their results stay `suspected`. Add `--offline` to guarantee that Veritas itself makes no network request (no web or GitHub sources, no LLM). Mutation testing and `improve` still run your own tests, as `pnpm test` would; to keep those off the network as well, run Veritas where there is no network, for example in a container started with `--network none`.

Results go to `.veritas/runs/<run-id>/`: `evidence.json`, `properties.json`, `test-map.json`, `mutation.json`, `pbt.json`, `claims.json` (with `proofs/` holding SMT and Lean inputs and outputs), `assessments.json`, `findings.json`, `run.json`, and `report.{json,md,html,sarif}`.

## 3. Read the results

```bash
veritas report                    # text summary
veritas report --format html > report.html
veritas explain <finding-id>      # quoted source -> property -> tests -> mutants -> solver claim
```

See [semantics](semantics.md) for what each status means.

## 4. Decide on specifications

```bash
veritas spec list
veritas spec show <property-id>
veritas spec accept <property-id> --reason "README is the source of truth" [--actor you]
veritas spec reject <property-id> --reason "outdated"
veritas spec diff
```

Decisions are appended to `.veritas/approvals.json`. Commit that file. A decision applies to the property version it was made for; if the property's content changes, it must be reviewed again.

## 5. Verify

```bash
veritas prove                      # Z3, accepted properties
veritas prove --engine lean        # Lean 4 kernel check
veritas test generate              # fast-check tests under .veritas/generated-tests/
```

## 6. Improve tests

```bash
veritas improve --dry-run
veritas improve --apply --plan <plan-id> --approve <token>
```

Only new test files are added, and only when mutation results improve in an isolated copy. Expected values come from accepted specifications, never from the implementation (`--include-proposed` explicitly allows proposed ones). Rejecting a property after planning invalidates the plan. Tests that would fail against the current code are reported as possible specification violations instead of being added.

## Configuration

`.veritas/config.json` is validated against `schemas/config.json`. Important settings:

| Setting                                                                      | Default                                | Meaning                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources.web.enabled`, `sources.github.enabled`                              | `false`                                | Network sources; the web also needs `allowDomains`                                                                                                                                                               |
| `sources.web.maxPages`, `maxDepth`, `maxChars`, `timeoutMs`, `maxDurationMs` | `30`, `1`, `200000`, `30000`, `120000` | Crawl budgets: pages, link depth, characters kept, time per page (body included) and for the whole crawl                                                                                                         |
| `formal.integerDomain`                                                       | `[-10000, 10000]`                      | Bounds for formal checks                                                                                                                                                                                         |
| `formal.maxSolverMs`                                                         | `30000`                                | Solver time limit per query                                                                                                                                                                                      |
| `formal.maxArrayLength`                                                      | `3`                                    | Element slots modelled for array parameters in formal checks (1 to 8); longer arrays are not covered                                                                                                             |
| `pbt.numRuns`, `pbt.seed`                                                    | `1000`, derived per property           | Property-based testing                                                                                                                                                                                           |
| `llm.provider`                                                               | `none`                                 | LLM-assisted extraction; see [LLM providers](#llm-providers)                                                                                                                                                     |
| `policy.confirmedViolation`                                                  | `fail`                                 | Exit 1 on confirmed violations                                                                                                                                                                                   |
| `policy.inconclusiveBehavior`                                                | `warn`                                 | `fail` turns inconclusive results into exit 4                                                                                                                                                                    |
| `policy.maxNewSurvivors`                                                     | unset                                  | Exit 1 when more mutants survive in this run's scope (the change with `--since`); inconclusive without mutation results                                                                                          |
| `policy.minPropertyCoverage`                                                 | unset                                  | Exit 1 when fewer accepted properties (share, 0–1) have a `meaningful_with_evidence` test; inconclusive without accepted properties                                                                              |
| `cache.enabled`                                                              | `true`                                 | Reuse results from `.veritas/cache/` (see below)                                                                                                                                                                 |
| `limits.memoryMb`                                                            | `2048`                                 | V8 heap limit (MiB) for sandboxed calls, property-based tests, the project's test runner and mutator, and the Z3 worker (at least 256). Lean is not limited. Running out of memory is an `error`, never a result |

The policy settings are the CI policies in the specification under camelCase names: `block_on_confirmed_spec_violation` is `policy.confirmedViolation` (`fail` blocks), `max_new_survivors` is `policy.maxNewSurvivors`, `min_property_coverage` is `policy.minPropertyCoverage` and `inconclusive_behavior` is `policy.inconclusiveBehavior`. The GitHub Action takes `inconclusive` as an input.

The cache keeps decisive Z3 results (`sat`/`unsat`, keyed by the SMT query, solver build and time limit), successful LLM responses (keyed by provider, model and the exact request) and complete mutation runs (keyed by the content of every file `git ls-files` lists, the mutator, Vitest and Node.js versions, the configuration and `--since`/scope). Undecided or failed results are never reused, a reused counterexample is still replayed in JavaScript, and reuse is shown in the stage messages and solver output. Without git, mutation results are not cached. Keep `.veritas/` out of version control: a cache tracked by git is ignored. Entries are signed with a key in your cache directory (`~/.cache/veritas/cache-key`, `%LOCALAPPDATA%\veritas\cache-key` on Windows, or `VERITAS_CACHE_KEY_FILE`); entries signed with another key, such as ones restored on a fresh CI runner without that key, are misses.

## LLM providers

An LLM is optional. It only reads free-text statements the rule-based extractor could not interpret; what it finds becomes experimental, proposed properties, never accepted ones. LLM requests are never made with `--offline`.

| `llm.provider` | Uses                                                    | Needs                                                              |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| `claude-code`  | The Claude Code CLI with your own login (Pro/Max plans) | `claude` on PATH and `claude auth login`                           |
| `codex`        | The Codex CLI with your own login (ChatGPT plans)       | `codex` on PATH, `codex login` and `llm.allowCodexFileReads: true` |
| `claude`       | The Anthropic API                                       | `ANTHROPIC_API_KEY`                                                |
| `openai`       | The OpenAI API (Responses, `store: false`)              | `OPENAI_API_KEY`                                                   |

`llm.model` picks the model (for the CLIs, any value their `--model` accepts). `veritas doctor` shows whether the provider is ready; it reads only the login state of a CLI, not account details. Veritas never handles CLI credentials, and does not pass API keys to the CLIs, so they always use their own login.

The CLIs run with as little as possible (Claude Code: no tools, MCP servers or settings; Codex: read-only sandbox, ephemeral session, no user config, browser, apps or web search) in an empty temporary directory, so they see only the quoted text Veritas sends. Usage counts toward your plan's limits.

Codex keeps a read-only shell that Veritas cannot switch off, so the model could read local files; Veritas therefore uses `codex` only with `llm.allowCodexFileReads: true`, and anything a model returns is kept only when it comes from the quoted statement. On Windows, `.exe` installs and npm/pnpm `.cmd` shims are supported (the shim's Node.js script is run directly, without a shell).

## Debugging

- `--debug` (or `VERITAS_DEBUG=1`) adds debug events to the stderr log: every child process Veritas starts (command, arguments, working directory, duration, exit code, timeout or kill), sandboxed calls, stage start and end, and cache hits and misses.
- `--log-format json` writes the stderr log as one JSON object per line (`time`, `level`, `message`, and fields such as `event`, `stage`, `durationMs`); stdout is unaffected, so `--json` output stays pure JSON.
- Every run also writes the same events, debug level included, to `.veritas/runs/<run-id>/trace.jsonl` (at most 4 MB; a final line says how many events were dropped). Logs and traces never include environment values or file contents, and everything is redacted.
- `veritas replay <run-id>` re-runs a run with its recorded stages and options.

## Troubleshooting

| Symptom                       | Cause and fix                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITEST_NOT_FOUND`            | Install Vitest in the project (`pnpm add -D vitest`)                                                                                                                               |
| `mutate` disabled in `doctor` | Install `@mizchi/mutator` in the project or install the project's dependencies                                                                                                     |
| Mutation stage `failed`       | The project's own tests fail; fix the baseline first                                                                                                                               |
| `semantic_mismatch`           | The integer model and JavaScript disagree (e.g. overflow beyond safe integers); narrow `formal.integerDomain` or rely on tests                                                     |
| `unsupported` claims          | The function uses constructs outside the formal subset (see the support matrix)                                                                                                    |
| Lean `unavailable`            | Install Lean with elan; `doctor` also looks in `~/.elan/bin`                                                                                                                       |
| `IMPROVE_APPLY_IN_CI`         | Applying improvements is refused in CI by design                                                                                                                                   |
| Sandbox `unavailable`         | Node.js below 25 cannot block network access from project code; install Node.js 25+ or point `VERITAS_SANDBOX_NODE` at one (`sandbox.allowNetworkWithoutIsolation` runs it anyway) |
