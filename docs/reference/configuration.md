# Configuration

Where Veritas reads its configuration, every setting with its default and allowed values, and how the result cache works.

## Example

`.veritas/config.json` needs only the settings that differ from the defaults:

```json
{
  "$schema": "https://veritas.invalid/schemas/config.json",
  "schemaVersion": "1.0.0",
  "project": { "packageManager": "pnpm", "tsconfig": "tsconfig.json" },
  "analysis": {
    "include": ["src/**/*.ts"],
    "testInclude": ["test/**/*.test.ts"]
  },
  "formal": { "integerDomain": { "min": "-1000000", "max": "1000000" } },
  "pbt": { "numRuns": 500 },
  "policy": {
    "confirmedViolation": "fail",
    "inconclusiveBehavior": "fail",
    "maxNewSurvivors": 0
  },
  "storage": { "retainRuns": 10 }
}
```

- `analysis.include` and `analysis.testInclude` select the source and test files. `veritas init` fills them in from what it detects.
- `formal.integerDomain` sets the integer range of formal checks. The bounds are decimal strings.
- `policy.inconclusiveBehavior: "fail"` makes inconclusive results end with exit code 4, which suits a CI gate.
- `policy.maxNewSurvivors: 0` fails the run when any mutant in scope survives.
- `storage.retainRuns: 10` keeps the ten most recent finished runs; runs still in progress are never removed.

## Where configuration lives

Veritas reads `.veritas/config.json` in the project root. `veritas init` creates it. The file is validated against [`schemas/config.json`](https://github.com/under18dev/veritas/blob/main/schemas/config.json); an unknown key or an invalid value fails with `CONFIG_INVALID` (exit code 2) and lists every invalid field.

You can write the configuration as code instead, in `veritas.config.ts`, `veritas.config.mjs` or `veritas.config.js` in the project root, with the same shape as its default export. Loading it runs project code, so Veritas loads it only with the global `--allow-code-config` option and otherwise fails with `CONFIG_CODE_NOT_ALLOWED`. A project may have only one configuration file (`CONFIG_AMBIGUOUS` otherwise), and a configuration file that is a symbolic link to a location outside the project is refused.

```ts
export default {
  project: { packageManager: 'pnpm', tsconfig: 'tsconfig.json' },
  analysis: { include: ['src/**/*.ts'], testInclude: ['test/**/*.test.ts'] },
  policy: { inconclusiveBehavior: 'fail', maxNewSurvivors: 0 },
};
```

Commit `.veritas/config.json` and `.veritas/approvals.json`; the [GitHub Action](/reference/github-action) needs the configuration in the repository. Keep `.veritas/runs/` and `.veritas/cache/` out of version control.

## All settings

<!--@include: ./_generated/configuration.md-->

## What the main settings do

| Setting                                                                      | Default                                | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources.web.enabled`, `sources.github.enabled`                              | `false`                                | Collect evidence from the web or from GitHub. The web source also needs `allowDomains`; the GitHub source reads `sources.github.repo` (`owner/name`). Neither runs with `--offline`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sources.web.maxPages`, `maxDepth`, `maxChars`, `timeoutMs`, `maxDurationMs` | `30`, `1`, `200000`, `30000`, `120000` | Limits of the web crawl: pages, link depth, characters kept, time per page, and time for the whole crawl. Pages not fetched in time are reported as skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `analysis.inferSpecsFromCode`                                                | `true`                                 | Propose candidate properties inferred from the code. With `false`, only documented sources produce properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mutation.mode`                                                              | `diff`                                 | `diff`: you are expected to pass `--since`; without it, all mutants in scope run and the stage messages say so. `full`: all mutants in scope run, without that message. In both modes, `--since` limits mutants to changed code                                                                                                                                                                                                                                                                                                                                                                                   |
| `mutation.timeoutMs`                                                         | `120000`                               | Time limit of a mutation run. Past 75% of it mutator starts no new mutant, and the rest is left for the running ones to finish. Mutants it did not start stay `pending` and the stage is `partial`. At the limit mutator is stopped and the stage is `timeout`                                                                                                                                                                                                                                                                                                                                                    |
| `mutation.typecheck`                                                         | `auto`                                 | `auto`: mutator type-checks mutants with the project's TypeScript before running them and leaves out those that do not compile. `off`: mutants start right after the baseline, which helps when type-checking takes too long on a large project. Mutants the compiler would reject are then run and counted too, so the counts read more favourably. When the root `tsconfig.json` only references other projects, type-checking is skipped either way                                                                                                                                                            |
| `mutation.confirmDisconnected`                                               | `true`                                 | After the main mutation run, check the tests static analysis could not link to project code: mutator runs again on their test files alone, mutating only the sources those files import, with every test run on every mutant and one mutant per line, within what is left of `mutation.timeoutMs`; the main run then stops starting new mutants at 55% of it instead of 75%. A test that kills a mutant is no longer reported as not checking project behaviour. With `false`, such tests keep what the main run says. See [reading results](/guide/reading-results#how-mutation-testing-confirms-a-missing-link) |
| `formal.integerDomain`                                                       | `-10000` to `10000`                    | Integer range of formal checks, within the safe-integer range                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `formal.maxSolverMs`                                                         | `30000`                                | Solver time limit per query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `formal.maxArrayLength`                                                      | `3`                                    | Longest array (1 to 8) that formal checks cover; longer arrays are not covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pbt.numRuns`, `pbt.seed`                                                    | `1000`, per property                   | Number of property-based test runs, and the seed. Without `seed`, each property gets a fixed seed derived from its id, so results are reproducible                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `llm.provider`                                                               | `none`                                 | LLM used to read free-text statements; see [LLM providers](/guide/llm-providers). `llm.maxTokensPerRun` limits the tokens of one run                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `policy.confirmedViolation`                                                  | `fail`                                 | `fail`: a confirmed violation ends with exit code 1. `warn`: it is reported as a warning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `policy.inconclusiveBehavior`                                                | `warn`                                 | `fail`: inconclusive results end with exit code 4. `warn` and `ignore`: exit code 0, with the verdict `pass_with_warnings` and every inconclusive result listed                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `policy.maxNewSurvivors`                                                     | unset                                  | Exit code 1 when more mutants survive in the run's scope (the changed code with `--since`). Inconclusive when there are no mutation results                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `policy.minPropertyCoverage`                                                 | unset                                  | Exit code 1 when the share (0 to 1) of accepted properties with a `meaningful_with_evidence` test is lower. Inconclusive when no property is accepted or the run has no test assessments                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sandbox.allowNetworkWithoutIsolation`                                       | `false`                                | Run project code even without a Node.js 25 or later that can block its network access. Otherwise those results stay inconclusive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `storage.retainRuns`                                                         | `20`                                   | Number of finished runs kept in `.veritas/runs/`, the current run included. Older finished runs are deleted when a run finishes; runs still in progress are kept                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cache.enabled`                                                              | `true`                                 | Reuse results from `.veritas/cache/` (see [Caching](#caching))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `limits.memoryMb`                                                            | `2048`                                 | Memory limit (MiB, at least 256) for processes that run project code, the project's tests, mutator and Z3. Lean is not limited. Running out of memory is an `error`                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Inconclusive results are claims that are `unknown`, `timeout`, `unsupported`, `semantic_mismatch` or `error`, and stages that are `partial`, `skipped`, `unsupported`, `timeout` or `cancelled`.

## Settings with a single allowed value

These settings state a rule and accept only one value. Any other value is an invalid configuration.

| Setting                                      | Only value | Rule                                                                      |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `analysis.requireApprovalForNormativeClaims` | `true`     | A property becomes `accepted` only through a recorded decision            |
| `improvement.testFilesOnly`                  | `true`     | `improve` only adds test files and never edits production code            |
| `improvement.autoApply`                      | `false`    | A plan is applied only with `--apply`, its plan id and its approval token |
| `storage.storePrompts`                       | `false`    | Prompts sent to an LLM are not stored                                     |
| `formal.rejectUnsupportedSemantics`          | `true`     | Code outside the formal subset is `unsupported`, never approximated       |
| `analysis.testFramework`                     | `vitest`   | Vitest is the supported test runner                                       |
| `mutation.backend`                           | `mizchi`   | `@mizchi/mutator` runs mutation testing                                   |

## Caching

Veritas keeps three kinds of results in `.veritas/cache/` and reuses them when the inputs are identical:

| Result                              | Reused when these are identical                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Decided Z3 results (`sat`, `unsat`) | The SMT query, the solver build and the time limit                                                                                   |
| Successful LLM responses            | The provider, the model and the request                                                                                              |
| Complete mutation runs              | The content of every file `git ls-files` lists, the mutator, Vitest and Node.js versions, the configuration, `--since` and the scope |

Undecided or failed results are not reused. A reused counterexample is still replayed in JavaScript, and the stage messages say when a result was reused. Without git, mutation results are not cached.

Entries are signed with a key stored outside the project, in `~/.cache/veritas/cache-key` (`%LOCALAPPDATA%\veritas\cache-key` on Windows) or the file named by `VERITAS_CACHE_KEY_FILE`. Entries signed with a different key, for example ones copied in with a repository or restored on a CI runner without the key, are ignored. A cache directory tracked by git is ignored as a whole.

The project's own tests, which mutation testing runs, can read the key. For code you do not trust, set `cache.enabled: false` (see [Security model](/concepts/security)).
