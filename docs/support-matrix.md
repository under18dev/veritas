# Support matrix

What works in the current build.

## Available

| Area                            | Notes                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`, `doctor`, configuration | `.veritas/config.json`; `veritas.config.ts/js` only with `--allow-code-config`                                                                                                               |
| Evidence discovery              | README, `docs/**/*.md`, JSDoc, OpenAPI/JSON Schema bounds, git log, exported issues/PRs (`.veritas-sources/`), CHANGELOG; GitHub API and web only when enabled in config and not `--offline` |
| Statement extraction            | Rule-based English and Japanese threshold phrases; optional LLM-assisted extraction through the Claude Code or Codex CLI with your own login, or the Anthropic or OpenAI API                 |
| Code intelligence               | TypeScript Compiler API; static only                                                                                                                                                         |
| Property registry               | proposed / reviewed / accepted / rejected / conflicted / superseded, append-only approvals                                                                                                   |
| Test inventory                  | Vitest `it`/`test`/`describe` incl. modifiers, assertions, mocks, snapshots                                                                                                                  |
| Mutation testing                | `@mizchi/mutator` 0.4.x                                                                                                                                                                      |
| Property-based testing          | fast-check, in a permission-model sandbox, fixed seeds                                                                                                                                       |
| Z3 checks                       | Bounded integer/boolean subset (see below), `z3-solver` (WASM)                                                                                                                               |
| Lean checks                     | Lean 4 with Lake when installed; proofs using `sorry`, `admit`, `native_decide` or extra axioms are rejected                                                                                 |
| Assessment and findings         | Evidence vectors; no single score                                                                                                                                                            |
| Improvement                     | `improve` plans new test files only; applying needs the plan id and approval token, runs in an isolated copy and rolls back unless mutation results improve; refused in CI                   |
| Reports                         | text, JSON, Markdown, self-contained HTML and SARIF 2.1.0                                                                                                                                    |
| CLI                             | All commands                                                                                                                                                                                 |
| MCP server                      | Read-only tools; applying an approved improvement plan only with `--allow-write`                                                                                                             |
| GitHub Action                   | Offline engine for `pull_request`, incremental with `since`; see [github-action.md](github-action.md)                                                                                        |
| Agent Skill                     | `skills/veritas/SKILL.md`                                                                                                                                                                    |

## Formal subset

| Construct                                                                   | Supported          |
| --------------------------------------------------------------------------- | ------------------ |
| Parameters/results of type `number` (as bounded safe integers) or `boolean` | Yes                |
| `if`/`else`, ternary, `return`, `const`                                     | Yes                |
| `+ - *`, comparisons, `=== !==`, `&&`, `\|\|`, `!`, unary `-`               | Yes                |
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

## External tools and licenses

Veritas is licensed under Apache-2.0. `pnpm licenses:check` fails when an installed dependency uses a license outside the allowlist in `scripts/check-licenses.mjs`.

| Tool                          | License    | How it is used                                       |
| ----------------------------- | ---------- | ---------------------------------------------------- |
| `@mizchi/mutator`             | MIT        | npm dependency, run as a separate process            |
| `z3-solver` (Z3)              | MIT        | npm dependency, WASM build                           |
| fast-check                    | MIT        | npm dependency, run in a sandboxed process           |
| Lean 4 and Lake               | Apache-2.0 | Installed separately by the user (elan); not bundled |
| `@anthropic-ai/sdk`           | Apache-2.0 | npm dependency of the optional Claude adapter        |
| lightningcss (through Vitest) | MPL-2.0    | Unmodified transitive dependency; never bundled      |
