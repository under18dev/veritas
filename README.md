# Veritas

Veritas checks what your tests actually guarantee. It reads the specification you already have (README, docs, JSDoc, OpenAPI/JSON Schema, git history, exported issues), relates it to your TypeScript code and Vitest tests, runs mutation testing and bounded formal checks, and reports each finding with the evidence behind it: the quoted source line, the property, the tests, the mutants and the solver result.

It does not claim that code is correct. Every result states what was checked, under which model and bounds, and what remains unknown.

> Status: not yet published to npm. Packages will be published as `@under18dev/veritas` (CLI) and `@under18dev/veritas-*`; see [ADR 0008](docs/adr/0008-package-name.md). Until then, install from a checkout as shown below.

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

- Node.js 24 or later. Property tests and counterexample replay run project code only under Node.js 25+, which can block its network access (26 LTS recommended); see the [support matrix](docs/support-matrix.md)
- A TypeScript/JavaScript project tested with Vitest
- Optional: [Lean 4](https://lean-lang.org/) for kernel-checked proofs

Z3 runs from the `z3-solver` package (WebAssembly); no separate install is needed.

## Quick start (from a clone)

```bash
pnpm install
pnpm build
cd /path/to/your/project
node /path/to/veritas/packages/cli/dist/bin.js init --yes
node /path/to/veritas/packages/cli/dist/bin.js doctor
node /path/to/veritas/packages/cli/dist/bin.js run --profile deep --offline --include-proposed
node /path/to/veritas/packages/cli/dist/bin.js report
node /path/to/veritas/packages/cli/dist/bin.js explain <finding-id>
```

## Commands

| Command                                                                | Purpose                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `veritas init [--yes] [--force] [--dry-run]`                           | Detect the project and write `.veritas/config.json`                          |
| `veritas doctor [--json]`                                              | Report available tools and which features are enabled, degraded or disabled  |
| `veritas discover [--offline] [--sources local,github,web]`            | Collect specification evidence                                               |
| `veritas spec list\|show\|accept\|reject\|diff\|export`                | Review properties; `accept`/`reject` record who decided and why              |
| `veritas analyze [path]`                                               | Map tests to properties and assess them (no project code executed)           |
| `veritas mutate [--since <ref>] [--scope <glob>]`                      | Mutation testing with [`@mizchi/mutator`](https://github.com/mizchi/mutator) |
| `veritas test generate [--property <id>] [--dry-run]`                  | Generate fast-check property tests                                           |
| `veritas prove [--engine z3\|lean] [--property <id>]`                  | Bounded checks with Z3, or kernel-checked proofs with Lean 4                 |
| `veritas run [--profile quick\|standard\|deep] [--offline]`            | The whole pipeline                                                           |
| `veritas report [--format text\|json\|markdown\|html\|sarif]`          | Print the latest results                                                     |
| `veritas explain <finding-id>`                                         | Evidence chain of a finding                                                  |
| `veritas improve [--dry-run \| --apply --plan <id> --approve <token>]` | Plan test-only improvements; apply an approved plan in an isolated copy      |
| `veritas replay <run-id>`                                              | Re-run a previous run with the same stages and options, offline              |

`discover --allow-domain <domain>` and `--max-pages <n>` add to and override `sources.web` for one run; web discovery still has to be enabled in the configuration.

Exit codes: `0` success, `1` confirmed policy failure, `2` invalid configuration or usage, `3` tool or infrastructure error, `4` inconclusive under the configured policy. With `--json`, stdout contains only JSON, usage errors included; `report --json` cannot be combined with another `--format`.

See the [support matrix](docs/support-matrix.md) for what is available in the current build.

## How to read results

- `proven_within_model` means no counterexample exists within the stated integer domain and assumptions. It is not a proof that the code is correct; see [docs/semantics.md](docs/semantics.md).
- `unknown`, `timeout`, `unsupported` and `semantic_mismatch` are never counted as success.
- Properties inferred from code are hypotheses. Only a person can accept a specification (`veritas spec accept <id> --reason "..."`).
- A surviving mutant is a test gap candidate, not a bug.

## Agents and MCP

- Agent Skill: [`skills/veritas/SKILL.md`](skills/veritas/SKILL.md)
- MCP server: `veritas-mcp --root <project>` (read-only analysis tools; `--allow-write` adds the tool that applies an approved improvement plan)
- GitHub Action: [docs/github-action.md](docs/github-action.md)

## Documentation

[User guide](docs/user-guide.md) · [Architecture](docs/architecture.md) · [Semantics](docs/semantics.md) · [Threat model](docs/threat-model.md) · [Support matrix](docs/support-matrix.md) · [ADRs](docs/adr/README.md)

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
