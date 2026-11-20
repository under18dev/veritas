# Configuration

## Where configuration lives

Veritas reads its configuration from `.veritas/config.json` in the project root. `veritas init` writes it with the detected package manager, `tsconfig.json`, and source and test globs; every other setting takes its default. The file is validated against [`schemas/config.json`](https://github.com/under18dev/veritas/blob/main/schemas/config.json), and an unknown key or an invalid value is a user error (`CONFIG_INVALID`, exit code 2) that lists each offending field.

A configuration written in code, `veritas.config.ts`, `veritas.config.mjs` or `veritas.config.js` in the project root, is loaded only with the global `--allow-code-config` option, because loading it executes project code. Without that option the command fails with `CONFIG_CODE_NOT_ALLOWED`. The module's default export must be an object of the same shape as the JSON file. Having both a JSON and a code configuration is an error (`CONFIG_AMBIGUOUS`), and a configuration file that is a symbolic link pointing outside the project is refused.

The configuration is hashed (`configHash`) into the metadata of every artifact, so a run always records which settings produced it.

Commit `.veritas/config.json` and `.veritas/approvals.json`. The [GitHub Action](/reference/github-action) needs the configuration in the repository. Keep `.veritas/runs/` and `.veritas/cache/` out of version control: a cache tracked by git is ignored.

## Example

`.veritas/config.json` only needs the settings that differ from the defaults. JSON has no comments, so the notes follow the example.

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

- `analysis.include` and `analysis.testInclude` are the globs `init` detected; adjust them when sources or tests live elsewhere.
- `formal.integerDomain` widens the bounds of formal checks. Bounds are decimal strings so that they stay exact.
- `policy.inconclusiveBehavior: "fail"` turns inconclusive results into exit code 4: claims that are `unknown`, `timeout`, `unsupported`, `semantic_mismatch` or `error`, and stages that are `partial`, `skipped`, `unsupported`, `timeout` or `cancelled`, which suits a CI gate.
- `policy.maxNewSurvivors: 0` fails the run when any mutant in scope survives.
- `storage.retainRuns: 10` keeps the ten most recent run directories.

The same configuration as `veritas.config.ts` (loaded only with `--allow-code-config`):

```ts
export default {
  project: { packageManager: 'pnpm', tsconfig: 'tsconfig.json' },
  analysis: { include: ['src/**/*.ts'], testInclude: ['test/**/*.test.ts'] },
  policy: { inconclusiveBehavior: 'fail', maxNewSurvivors: 0 },
};
```

## All settings

The tables below are generated from `schemas/config.json`.

<!--@include: ./_generated/configuration.md-->

## Important settings

| Setting                                                                      | Default                                | Meaning                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources.web.enabled`, `sources.github.enabled`                              | `false`                                | Network sources. The web source also needs `allowDomains`; the GitHub source reads `sources.github.repo` (`owner/name`). Neither runs with `--offline`                                                                                    |
| `sources.web.maxPages`, `maxDepth`, `maxChars`, `timeoutMs`, `maxDurationMs` | `30`, `1`, `200000`, `30000`, `120000` | Crawl budgets: pages, link depth, characters kept, time per page (body included), and time for the whole crawl. Pages not fetched in time are reported as skipped                                                                         |
| `analysis.inferSpecsFromCode`                                                | `true`                                 | Propose candidate properties inferred from the code. With `false`, code-inferred candidates are kept out of the registry and only documented sources produce properties                                                                   |
| `mutation.mode`                                                              | `diff`                                 | The expected way of running mutation testing. `--since` is what limits mutants to a change, whatever the mode; with `diff` and no `--since`, the stage messages note that every mutant in scope ran. `full` drops that note               |
| `formal.integerDomain`                                                       | `-10000` to `10000`                    | Bounds for formal checks, inside the safe-integer range                                                                                                                                                                                   |
| `formal.maxSolverMs`                                                         | `30000`                                | Solver time limit per query                                                                                                                                                                                                               |
| `formal.maxArrayLength`                                                      | `3`                                    | Element slots modelled for array parameters in formal checks (1 to 8); longer arrays are not covered                                                                                                                                      |
| `pbt.numRuns`, `pbt.seed`                                                    | `1000`, derived per property           | Property-based testing. Without `seed`, each property gets a fixed seed derived from its id, so runs are reproducible                                                                                                                     |
| `llm.provider`                                                               | `none`                                 | LLM-assisted extraction of free-text statements; see [LLM providers](/guide/llm-providers). `llm.maxTokensPerRun` caps the tokens of one run                                                                                              |
| `policy.confirmedViolation`                                                  | `fail`                                 | Exit 1 on confirmed violations; `warn` reports them as warnings                                                                                                                                                                           |
| `policy.inconclusiveBehavior`                                                | `warn`                                 | `fail` turns inconclusive results into exit 4. `warn` and `ignore` keep exit 0, but the verdict stays `pass_with_warnings` and lists every inconclusive item                                                                              |
| `policy.maxNewSurvivors`                                                     | unset                                  | Exit 1 when more mutants survive in this run's scope (the change with `--since`); inconclusive without mutation results                                                                                                                   |
| `policy.minPropertyCoverage`                                                 | unset                                  | Exit 1 when the share (0 to 1) of accepted properties that have a `meaningful_with_evidence` test is lower; inconclusive without accepted properties                                                                                      |
| `sandbox.allowNetworkWithoutIsolation`                                       | `false`                                | Run project code even when no Node.js 25+ is available to block its network access. Without it, such results stay inconclusive                                                                                                            |
| `storage.retainRuns`                                                         | `20`                                   | Run directories kept under `.veritas/runs/`. When a run finishes, older directories beyond this number are removed                                                                                                                        |
| `cache.enabled`                                                              | `true`                                 | Reuse results from `.veritas/cache/` (see below)                                                                                                                                                                                          |
| `limits.memoryMb`                                                            | `2048`                                 | V8 heap limit (MiB) for restricted calls of project code, property-based tests, the project's test runner and mutator, and the Z3 solver process (at least 256). Lean is not limited. Running out of memory is an `error`, never a result |

The policy settings correspond to the CI policies of the specification: `block_on_confirmed_spec_violation` is `policy.confirmedViolation` (`fail` blocks), `max_new_survivors` is `policy.maxNewSurvivors`, `min_property_coverage` is `policy.minPropertyCoverage`, and `inconclusive_behavior` is `policy.inconclusiveBehavior`. The GitHub Action also takes `inconclusive` as an input.

## Settings with a single allowed value

Some settings exist only to state a rule. They accept exactly one value, and any other value is rejected as invalid configuration:

| Setting                                      | Only value | Rule it states                                                            |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `analysis.requireApprovalForNormativeClaims` | `true`     | A property becomes `accepted` only through an explicit approval record    |
| `improvement.testFilesOnly`                  | `true`     | `improve` only adds test files; production code is never edited           |
| `improvement.autoApply`                      | `false`    | A plan is applied only with `--apply`, its plan id and its approval token |
| `storage.storePrompts`                       | `false`    | Prompts sent to an LLM are not stored with the run artifacts              |
| `formal.rejectUnsupportedSemantics`          | `true`     | Code outside the formal subset is `unsupported`, never approximated       |
| `analysis.testFramework`                     | `vitest`   | Vitest is the supported test runner                                       |
| `mutation.backend`                           | `mizchi`   | `@mizchi/mutator` is the mutation backend                                 |

## Caching

The cache under `.veritas/cache/` keeps three kinds of results:

| Kind                                 | Key                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Decisive Z3 results (`sat`, `unsat`) | The SMT query, the solver build and the time limit                                                                                       |
| Successful LLM responses             | The provider, the model and the exact request                                                                                            |
| Complete mutation runs               | The content of every file `git ls-files` lists, the mutator, Vitest and Node.js versions, the configuration, and `--since` and the scope |

Undecided or failed results are never reused. A reused counterexample is still replayed in JavaScript, and reuse is shown in the stage messages and the solver output. Without git, mutation results are not cached.

Entries are signed with a key kept outside the project: `~/.cache/veritas/cache-key`, `%LOCALAPPDATA%\veritas\cache-key` on Windows, or the file named by `VERITAS_CACHE_KEY_FILE`. Entries signed with another key, such as entries copied in with a repository or restored on a fresh CI runner without that key, are cache misses. A cache tracked by git is ignored entirely. The project's own tests, which mutation testing runs, could still read the key; set `cache.enabled: false` for code you do not trust (see [Security model](/concepts/security)).
