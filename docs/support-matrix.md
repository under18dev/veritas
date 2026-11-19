# Support matrix

What works in the current build. Planned items are listed separately and are not available yet.

## Available

| Area                            | Status     | Notes                                                                                                                                                                                        |
| ------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`, `doctor`, configuration | Available  | `.veritas/config.json`; `veritas.config.ts/js` only with `--allow-code-config`                                                                                                               |
| Evidence discovery              | Available  | README, `docs/**/*.md`, JSDoc, OpenAPI/JSON Schema bounds, git log, exported issues/PRs (`.veritas-sources/`), CHANGELOG; GitHub API and web only when enabled in config and not `--offline` |
| Statement extraction            | Rule-based | English and Japanese threshold phrases; everything else is kept as free text                                                                                                                 |
| Code intelligence               | Available  | TypeScript Compiler API; static only                                                                                                                                                         |
| Property registry               | Available  | proposed / reviewed / accepted / rejected / conflicted / superseded, append-only approvals                                                                                                   |
| Test inventory                  | Available  | Vitest `it`/`test`/`describe` incl. modifiers, assertions, mocks, snapshots                                                                                                                  |
| Mutation testing                | Available  | `@mizchi/mutator` 0.4.x                                                                                                                                                                      |
| Property-based testing          | Available  | fast-check, in a permission-model sandbox, fixed seeds                                                                                                                                       |
| Z3 checks                       | Available  | Bounded integer/boolean subset (see below)                                                                                                                                                   |
| Assessment and findings         | Available  | Evidence vectors; no single score                                                                                                                                                            |
| CLI                             | Available  | All commands except `improve`                                                                                                                                                                |
| MCP server                      | Available  | Read-only tools                                                                                                                                                                              |
| Agent Skill                     | Available  | `skills/veritas/SKILL.md`                                                                                                                                                                    |

## Formal subset

| Construct                                                                   | Supported          |
| --------------------------------------------------------------------------- | ------------------ |
| Parameters/results of type `number` (as bounded safe integers) or `boolean` | Yes                |
| `if`/`else`, ternary, `return`, `const`                                     | Yes                |
| `+ - *`, comparisons, `=== !==`, `&&                                        |                    | !`, unary `-` | Yes |
| Calls to other supported functions in the same file                         | Yes (no recursion) |
| `/`, `%`, `**`, floats, `NaN`, `Infinity`, `==`, `??`, casts                | Unsupported        |
| Loops, `let`/`var`, side effects, async, generators, `this`, external state | Unsupported        |

## Environments

| Item        | Supported                                     |
| ----------- | --------------------------------------------- |
| Node.js     | 24 or later; sandbox network isolation on 25+ |
| OS          | Linux, macOS, Windows (CI matrix)             |
| Test runner | Vitest                                        |
| Languages   | TypeScript, JavaScript (ESM)                  |

## Planned

Lean 4 backend, `improve` (test-only improvement loop), HTML/Markdown/SARIF reports, MCP write tools with approval, GitHub Action, LLM-assisted extraction (Claude adapter).
