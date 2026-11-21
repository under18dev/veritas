# Node API

Everything `@under18dev/veritas` exports for use from Node.js is listed here. The functions run the same stages as the matching `veritas` command, write the same kind of files to `.veritas/runs/<run-id>/`, and return a verdict and exit code computed the same way. Some defaults differ from the CLI; pass the options in the table below to get the same behaviour.

```bash
pnpm add -D @under18dev/veritas
```

The package is ESM only and needs Node.js 24 or later.

```ts
import { analyze, run } from '@under18dev/veritas';

const result = await analyze({ root: '/path/to/project' });
console.log(result.decision.verdict, result.decision.exitCode); // e.g. "pass_with_warnings", 0

for (const finding of result.findings) console.log(finding.id, finding.certainty, finding.title);

const deep = await run({ root: '/path/to/project', profile: 'deep', offline: true });
console.log(deep.runId, deep.dir);
```

## Running stages

| Function                       | CLI equivalent     | Stages                                                             | Default `offline` |
| ------------------------------ | ------------------ | ------------------------------------------------------------------ | ----------------- |
| `discover(options)`            | `veritas discover` | discover                                                           | `false`           |
| `analyze(options)`             | `veritas analyze`  | index, discover, spec, map, assess                                 | `true`            |
| `mutate(options)`              | `veritas mutate`   | index, discover, spec, map, mutate, assess                         | `true`            |
| `prove(options)`               | `veritas prove`    | index, discover, spec, map, prove, assess, report                  | `true`            |
| `run({ profile, ...options })` | `veritas run`      | the stages of the profile (`quick`, `standard` by default, `deep`) | `false`           |
| `runVeritas(options)`          | none               | any list of stages; dependencies listed earlier run too            | `false`           |

Defaults that differ from the CLI:

- `discover()` collects the network sources enabled in the configuration. `veritas discover` collects only `local` unless you pass `--sources`; pass `sources: ['local']` for the same behaviour.
- `analyze()`, `mutate()` and `prove()` default to `offline: true` and accept `offline: false`. The matching commands are always offline.

`COMMAND_STAGES` (for `discover`, `analyze`, `mutate` and `prove`) and `PROFILE_STAGES` (for each profile) hold these stage lists.

### Options

`discover`, `analyze`, `mutate`, `prove` and `run` take `StageOptions`, which is `RunOptions` without `command` and `stages`. `runVeritas` takes the full `RunOptions`.

| Option             | Type                                             | Meaning                                                                                             |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `root`             | `string`                                         | Project root. Required                                                                              |
| `command`          | `string`                                         | Name recorded in `run.json` (`runVeritas` only)                                                     |
| `stages`           | `StageName[]`                                    | Stages to run (`runVeritas` only)                                                                   |
| `profile`          | `'quick' \| 'standard' \| 'deep'`                | Recorded profile; `run` selects its stages from it                                                  |
| `offline`          | `boolean`                                        | Make no network request: no GitHub or web sources, no LLM                                           |
| `localSourcesOnly` | `boolean`                                        | Collect only local sources but still allow a configured LLM                                         |
| `sources`          | `('local' \| 'github' \| 'web')[]`               | Sources to collect; by default local plus the network sources enabled in the configuration          |
| `web`              | `{ allowDomains?: string[]; maxPages?: number }` | Web discovery overrides, like `--allow-domain` and `--max-pages`                                    |
| `since`            | `string`                                         | Git ref; limits mutation testing to the change, like `--since`                                      |
| `scope`            | `string[]`                                       | Source globs to mutate, like `--scope`                                                              |
| `mutationReport`   | `string`                                         | Import this mutation-testing-elements report (path inside the project) instead of running mutator   |
| `killMatrix`       | `boolean`                                        | Run every covering test for every mutant (slower)                                                   |
| `includeProposed`  | `boolean`                                        | Also check properties that are not accepted; findings from them are at most `suspected`             |
| `formalEngine`     | `'z3' \| 'lean' \| 'both'`                       | Backend for conformance claims (mutant equivalence always uses Z3). Default: `formal.backend`       |
| `propertyIds`      | `string[]`                                       | Limit verification to these properties                                                              |
| `allowCodeConfig`  | `boolean`                                        | Allow loading `veritas.config.{ts,mjs,js}`, which executes project code                             |
| `gitRoot`          | `string`                                         | Repository whose git revision and log describe `root` when `root` is a copy without `.git`          |
| `signal`           | `AbortSignal`                                    | Cancels running stages and their child processes                                                    |
| `log`              | `(message: string) => void`                      | Progress messages (info level and above)                                                            |
| `logger`           | `LogSink`                                        | Every structured event, debug level included                                                        |
| `llmProvider`      | `LlmProvider \| null`                            | An LLM provider to use instead of the configured one, for example in tests; `null` disables the LLM |

### Result

Every stage function resolves to a `RunSummary`:

| Field      | Type             | Meaning                                                      |
| ---------- | ---------------- | ------------------------------------------------------------ |
| `runId`    | `string`         | The run id, for example `run-20261120T100618836Z-000-1951f4` |
| `dir`      | `string`         | Absolute path of `.veritas/runs/<run-id>/`                   |
| `run`      | `Run`            | The content of `run.json`: stages, options, status, verdict  |
| `findings` | `Finding[]`      | The findings of the run                                      |
| `decision` | `PolicyDecision` | `{ verdict, exitCode, reasons }`, as the CLI reports them    |

`decision.exitCode` follows the [CLI exit codes](/reference/cli#exit-codes) and `decision.verdict` is one of `pass`, `pass_with_warnings`, `policy_failure`, `tool_error` and `inconclusive`. A stage that fails is recorded in `run.stages` and reflected in the decision; it does not reject the promise.

### Errors

Invalid input, a missing configuration or an unknown id throws a `VeritasError`. Its `category` (`user`, `tool`, `policy`, `inconclusive`) maps to the exit codes 2, 3, 1 and 4, `exitCode` holds the code, `code` is a stable identifier such as `CONFIG_MISSING` or `NO_RUN`, and `hint` suggests a fix. `ExitCode` is exported as a constant object (`Success`, `PolicyFailure`, `UserError`, `ToolError`, `Inconclusive`).

```ts
import { ExitCode, readLatest, VeritasError } from '@under18dev/veritas';

try {
  readLatest('/path/to/project', 'findings');
} catch (error) {
  if (error instanceof VeritasError && error.code === 'NO_RUN') console.error(error.hint);
  else throw error;
}
```

## Reading results

| Export                                     | Purpose                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `readArtifact(root, runId, name)`          | Read and validate one artifact of a run; returns `{ meta, data }`                                                         |
| `readLatest(root, name)`                   | The same for the most recent run that has the artifact; returns `{ runId, meta, data }`                                   |
| `latestRunWith(root, name)`                | Id of the most recent run that has the artifact, or `null`                                                                |
| `ARTIFACTS`                                | Artifact names with their file names and schemas                                                                          |
| `explainFinding(root, findingId)`          | The evidence chain of a finding (`veritas explain`): sources, statements, properties, tests, assessments, mutants, claims |
| `buildReportInput(root, runId?)`           | Collect the data of a report from a run (default: the latest)                                                             |
| `renderReport(input, format)`              | Render it as `text`, `json`, `markdown`, `html` or `sarif`                                                                |
| `renderCiSummary(input, { artifactUrl? })` | Render a short Markdown summary for CI, with an optional link to the uploaded run                                         |
| `REPORT_FILES`                             | File names of the rendered reports in a run directory                                                                     |
| `improvementsFor(root, runId)`             | Improvement plans made from a run, with their apply attempts                                                              |

Artifact names for `readArtifact` and `readLatest` are `run`, `evidence`, `codeIndex`, `properties`, `testMap`, `mutation`, `claims`, `pbt`, `assessments`, `findings` and `artifactIndex`. The data is typed by name (`ArtifactData<'findings'>`). See [Reports and artifacts](/reference/reports) for the files.

```ts
import { buildReportInput, renderReport } from '@under18dev/veritas';

const markdown = renderReport(buildReportInput('/path/to/project'), 'markdown');
```

## Specifications

| Export                                                               | CLI equivalent                       | Purpose                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `listProperties(root)`                                               | `veritas spec list`                  | Properties of the latest run with the approval ledger applied                                                   |
| `showProperty(root, id)`                                             | `veritas spec show`                  | One property and its approval records                                                                           |
| `decideProperty(root, id, 'accept' \| 'reject', { reason, actor? })` | `veritas spec accept`, `spec reject` | Append a decision to `.veritas/approvals.json`; the actor defaults to `VERITAS_ACTOR`, then the git `user.name` |
| `diffLatest(root)`                                                   | `veritas spec diff`                  | Differences between the properties of the two most recent runs                                                  |

## Property-based tests

| Export                                                                    | CLI equivalent          | Purpose                                                                                                           |
| ------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `generateTests(root, { propertyId?, dryRun?, force?, allowCodeConfig? })` | `veritas test generate` | Generate fast-check test files, in the test runner's syntax, under `.veritas/generated-tests/`; returns the files |
| `replayPbt(root, pbtId, { runId?, signal? })`                             | `veritas test replay`   | Replay a recorded property-based test; `reproduced` says whether the recorded result came back                    |
| `defaultSeed(propertyId)`                                                 | none                    | The seed used for a property when `pbt.seed` is not set                                                           |

## Improvements

| Export                                                                         | CLI equivalent              | Purpose                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `planImprovement({ root, runId?, includeProposed?, maxIterations?, signal? })` | `veritas improve --dry-run` | Plan test-only improvements; returns a `PlanResult` with `planId`, `outcome`, `plan` and `approvalToken` |
| `applyImprovement({ root, planId, approvalToken, actor?, via?, signal? })`     | `veritas improve --apply`   | Apply an approved plan in an isolated copy; returns the `PatchAttempt`. Refused in CI                    |

`PlanResult.outcome` is `planned` when a plan is ready for approval, or one of `improved`, `no_safe_improvement`, `needs_spec_decision`, `blocked`, `error`. `approvalToken` is `null` when there is nothing to apply. See [Improving tests](/guide/improving-tests).

## Project setup

| Export                                    | CLI equivalent   | Purpose                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initProject(root, { force?, dryRun? })`  | `veritas init`   | Detect the project and write `.veritas/config.json`; returns the config and next steps                                                                                                                     |
| `loadConfig(root, { allowCodeConfig? })`  | none             | Load and validate the configuration; returns `{ config, file, hash }`                                                                                                                                      |
| `openProject(root, { allowCodeConfig? })` | none             | Load the configuration; returns `{ root, config, configHash }`                                                                                                                                             |
| `runDoctor(root, config, env?, bundled?)` | `veritas doctor` | Check capabilities and features; pass `null` as `config` to check without a configuration. Pass `bundledTools()` as `bundled` so that the tools installed with Veritas are found, as `veritas doctor` does |
| `bundledTools()`                          | none             | Versions of `@mizchi/mutator`, fast-check and `z3-solver` installed with Veritas (`null` for a tool that cannot be found)                                                                                  |

## CLI program

`main(argv)` runs the `veritas` command with the given arguments and resolves to its exit code. `buildProgram(setExit, writeOut?)` returns the underlying Commander program.

## Types

The package exports these types: `Finding`, `FormalClaim`, `Mutant`, `Property`, `Run`, `TestAssessment`, `VeritasConfig`, `RunOptions`, `StageOptions`, `RunSummary`, `Profile`, `ArtifactName`, `ArtifactData`, `ReportFormat`, `Explanation`, `GeneratedTest`, `PbtReplay`, `OpenOptions`, `PlanOutcome` and `PlanResult`. The JSON Schemas of the domain types are in [`schemas/`](https://github.com/under18dev/veritas/tree/main/schemas).
