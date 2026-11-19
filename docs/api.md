# Node API

`@under18dev/veritas` exports the same functions the CLI calls. They write the same artifacts under
`.veritas/runs/<run-id>/` and return the same verdict and exit code; nothing here starts the CLI.

```ts
import { analyze, mutate, prove, run, discover } from '@under18dev/veritas';

const result = await analyze({ root: '/path/to/project' });
console.log(result.decision.verdict, result.decision.exitCode); // e.g. "pass_with_warnings", 0
for (const finding of result.findings) console.log(finding.id, finding.certainty, finding.title);
```

| Function                       | CLI equivalent     | Stages                                                   |
| ------------------------------ | ------------------ | -------------------------------------------------------- |
| `discover(options)`            | `veritas discover` | discover                                                 |
| `analyze(options)`             | `veritas analyze`  | index, discover, spec, map, assess                       |
| `mutate(options)`              | `veritas mutate`   | index, discover, spec, map, mutate, assess               |
| `prove(options)`               | `veritas prove`    | index, discover, spec, map, prove, assess, report        |
| `run({ profile, ...options })` | `veritas run`      | the stages of the profile (`quick`, `standard`, `deep`)  |
| `runVeritas(options)`          | –                  | any list of stages; dependencies listed earlier also run |

Common options: `root` (required), `offline`, `since`, `scope`, `includeProposed`, `propertyIds`, `formalEngine`
(`'z3' | 'lean'`), `sources`, `signal` (an `AbortSignal` that cancels running stages and their child processes),
and `log`. `analyze`, `mutate` and `prove` default to `offline: true`, like the CLI.

Each function resolves to `{ runId, dir, run, findings, decision }`. `decision.exitCode` follows the CLI exit
codes (`0` success, `1` confirmed policy failure, `2` user error, `3` tool error, `4` inconclusive). Invalid
input throws a `VeritasError` whose `category` maps to the same codes.

Also exported: `readArtifact`/`readLatest` to read run artifacts, `buildReportInput`/`renderReport` for reports,
`explainFinding`, the `spec` helpers (`listProperties`, `decideProperty`, `diffLatest`), `generateTests`,
`planImprovement`/`applyImprovement`, `initProject`, `loadConfig` and `runDoctor`.
