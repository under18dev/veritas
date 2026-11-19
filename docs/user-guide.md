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

Add `--include-proposed` to check properties that nobody has accepted yet. Their results stay `suspected`. Add `--offline` to guarantee that no network source is used.

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

Only new test files are added, and only when mutation results improve in an isolated copy. Expected values come from the specification, never from the implementation. Tests that would fail against the current code are reported as possible specification violations instead of being added.

## Configuration

`.veritas/config.json` is validated against `schemas/config.json`. Important settings:

| Setting                                         | Default                      | Meaning                                                           |
| ----------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `sources.web.enabled`, `sources.github.enabled` | `false`                      | Network sources; the web also needs `allowDomains`                |
| `formal.integerDomain`                          | `[-10000, 10000]`            | Bounds for formal checks                                          |
| `formal.maxSolverMs`                            | `30000`                      | Solver time limit per query                                       |
| `pbt.numRuns`, `pbt.seed`                       | `1000`, derived per property | Property-based testing                                            |
| `llm.provider`                                  | `none`                       | `claude` enables LLM-assisted extraction with `ANTHROPIC_API_KEY` |
| `policy.confirmedViolation`                     | `fail`                       | Exit 1 on confirmed violations                                    |
| `policy.inconclusiveBehavior`                   | `warn`                       | `fail` turns inconclusive results into exit 4                     |

## Troubleshooting

| Symptom                       | Cause and fix                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `VITEST_NOT_FOUND`            | Install Vitest in the project (`pnpm add -D vitest`)                                                                           |
| `mutate` disabled in `doctor` | Install `@mizchi/mutator` in the project or install the project's dependencies                                                 |
| Mutation stage `failed`       | The project's own tests fail; fix the baseline first                                                                           |
| `semantic_mismatch`           | The integer model and JavaScript disagree (e.g. overflow beyond safe integers); narrow `formal.integerDomain` or rely on tests |
| `unsupported` claims          | The function uses constructs outside the formal subset (see the support matrix)                                                |
| Lean `unavailable`            | Install Lean with elan; `doctor` also looks in `~/.elan/bin`                                                                   |
| `IMPROVE_APPLY_IN_CI`         | Applying improvements is refused in CI by design                                                                               |
| Sandbox `degraded`            | Node.js below 25 cannot block network access from executed project code                                                        |
