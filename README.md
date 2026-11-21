# Veritas

Veritas checks what your tests actually guarantee. It reads the specification you already have (README, docs, JSDoc, OpenAPI/JSON Schema, git history, exported issues), relates it to your TypeScript code and Vitest tests, runs mutation testing and bounded formal checks, and reports each finding with the evidence behind it: the quoted source line, the property, the tests, the mutants and the solver result.

It does not claim that code is correct. Every result states what was checked, under which model and bounds, and what remains unknown.

**Documentation: [veritas.under18.dev](https://veritas.under18.dev/)** ([日本語](https://veritas.under18.dev/ja/))

## What it finds

On a project whose README says "orders of 1000 or more receive a discount of 100" and whose code says `total > 1000`:

```text
F-6612cd973417  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
F-0b43c88cc3a6  [confirmed medium] no test detects total > 1000 -> total >= 1000 at src/pricing.ts:3
F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour
```

- specification vs implementation mismatches, with a counterexample found by Z3 and replayed in JavaScript;
- conflicting specifications (for example README vs a later issue), left for a person to decide;
- tests that assert nothing about the code, tests that miss a boundary, surviving mutants and an input that would kill them;
- properties checked by fast-check with a recorded seed, and by Z3 within a bounded integer model;
- safe, test-only improvements, measured in an isolated copy and rolled back if they do not help.

## Requirements

- Node.js 24 or later. Property tests and counterexample replay run project code only under Node.js 25+, which can block its network access, unless `sandbox.allowNetworkWithoutIsolation` is set (26 LTS recommended). The project's code is trusted code: analyse untrusted repositories in a container ([guide](https://veritas.under18.dev/guide/untrusted-repositories)).
- A TypeScript/JavaScript project tested with Vitest
- Optional: [Lean 4](https://lean-lang.org/) for kernel-checked proofs

Z3 runs from the `z3-solver` package (WebAssembly); no separate install is needed. See the [support matrix](https://veritas.under18.dev/concepts/support-matrix).

## Quick start

```bash
npm install -D @under18dev/veritas
npx veritas init --yes
npx veritas doctor
npx veritas run --profile deep --offline --include-proposed
npx veritas report
npx veritas explain <finding-id>
```

The [tutorial](https://veritas.under18.dev/guide/tutorial) walks through a complete example.

To use Veritas interactively, install it globally and run `veritas` without arguments in your project. It opens a [terminal UI](https://veritas.under18.dev/guide/tui) for results, specifications, runs, test improvement and settings:

```bash
npm install -g @under18dev/veritas
veritas
```

## Commands

| Command                                                                | Purpose                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `veritas init [--yes] [--force] [--dry-run]`                           | Detect the project and write `.veritas/config.json`                          |
| `veritas doctor [--json]`                                              | Report available tools and which features are enabled, degraded or disabled  |
| `veritas discover [--offline] [--sources local,github,web]`            | Collect specification evidence                                               |
| `veritas spec list\|show\|accept\|reject\|diff\|export`                | Review properties; `accept`/`reject` record who decided and why              |
| `veritas analyze [path]`                                               | Map tests to properties and assess them (no project code executed)           |
| `veritas mutate [--since <ref>] [--scope <glob>] [--kill-matrix]`      | Mutation testing with [`@mizchi/mutator`](https://github.com/mizchi/mutator) |
| `veritas test generate [--property <id>] [--dry-run]`                  | Generate fast-check property tests                                           |
| `veritas test replay <pbt-id>`                                         | Replay a recorded property-based test with its seed and shrink path          |
| `veritas prove [--engine z3\|lean] [--property <id>]`                  | Bounded checks with Z3, or kernel-checked proofs with Lean 4                 |
| `veritas run [--profile quick\|standard\|deep] [--offline]`            | The whole pipeline                                                           |
| `veritas report [--format text\|json\|markdown\|html\|sarif]`          | Print the latest results                                                     |
| `veritas explain <finding-id>`                                         | Evidence chain of a finding                                                  |
| `veritas improve [--dry-run \| --apply --plan <id> --approve <token>]` | Plan test-only improvements; apply an approved plan in an isolated copy      |
| `veritas replay <run-id>`                                              | Re-run a previous run with the same stages and options, offline              |

`mutate --import <report.json>` normalizes an existing mutation-testing-elements report (for example from Stryker) instead of running mutator. `discover --allow-domain <domain>` and `--max-pages <n>` add to and override `sources.web` for one run; web discovery still has to be enabled in the configuration.

Global options: `--json`, `-C <dir>`, `--debug` (child processes, stages and cache on stderr; also `VERITAS_DEBUG=1`), `--log-format text|json`; every run also keeps a trace in `.veritas/runs/<run-id>/trace.jsonl` (see [troubleshooting](https://veritas.under18.dev/guide/troubleshooting)).

Exit codes: `0` success, `1` confirmed policy failure, `2` invalid configuration or usage, `3` tool or infrastructure error, `4` inconclusive under the configured policy. With `--json`, stdout contains only JSON, usage errors included; `report --json` cannot be combined with another `--format`.

The [CLI reference](https://veritas.under18.dev/reference/cli) lists every option.

## How to read results

- `proven_within_model` means no counterexample exists within the stated integer domain and assumptions. It is not a proof that the code is correct; see [semantics](https://veritas.under18.dev/concepts/semantics).
- `unknown`, `timeout`, `unsupported` and `semantic_mismatch` are never counted as success.
- Properties inferred from code are hypotheses. Only a person can accept a specification (`veritas spec accept <id> --reason "..."`).
- A surviving mutant is a test gap candidate, not a bug.

## Agents and MCP

- Agent Skill: [`skills/veritas/SKILL.md`](skills/veritas/SKILL.md)
- MCP server: `veritas-mcp --root <project>` ([reference](https://veritas.under18.dev/reference/mcp)) (read-only analysis tools; `--allow-write` adds the tool that applies an approved improvement plan). Each client session runs its own server process over stdio; each tool that runs analysis stages writes a new run directory, at most `--max-concurrent` long operations run at once (others wait or are cancelled), and applying a plan measures it in a fresh temporary copy that is deleted afterwards.
- GitHub Action: [reference](https://veritas.under18.dev/reference/github-action)
- Node API: [reference](https://veritas.under18.dev/reference/api) (`import { analyze } from '@under18dev/veritas'`)

## Documentation

The documentation site is at [veritas.under18.dev](https://veritas.under18.dev/), in English and [Japanese](https://veritas.under18.dev/ja/): [guide](https://veritas.under18.dev/guide/getting-started) · [reference](https://veritas.under18.dev/reference/cli) · [concepts](https://veritas.under18.dev/concepts/semantics) · [ADRs](docs/adr/README.md). Its sources are in [`docs/`](docs/) (`pnpm docs:dev`).

## Development

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test                 # unit tests
pnpm test:acceptance      # end-to-end tests against fixtures/
pnpm exec vitest run --project unit packages/formal-core   # one package
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
