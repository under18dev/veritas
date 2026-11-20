# Support matrix

What the current release supports: features, the formal subset, environments and external tools. For the meaning of each result, see [Semantics](/concepts/semantics).

## Available

| Area                            | Notes                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`, `doctor`, configuration | `.veritas/config.json`; `veritas.config.{ts,mjs,js}` only with `--allow-code-config`                                                                                                         |
| Evidence discovery              | README, `docs/**/*.md`, JSDoc, OpenAPI/JSON Schema bounds, git log, exported issues/PRs (`.veritas-sources/`), CHANGELOG; GitHub API and web only when enabled in config and not `--offline` |
| Statement extraction            | Rule-based English and Japanese threshold phrases; optional LLM-assisted extraction through the Claude Code or Codex CLI with your own login, or the Anthropic or OpenAI API                 |
| Code intelligence               | TypeScript Compiler API; static only                                                                                                                                                         |
| Property registry               | proposed / reviewed / accepted / rejected / conflicted / superseded, append-only approvals                                                                                                   |
| Test inventory                  | Vitest `it`/`test`/`describe` incl. modifiers, assertions, mocks, snapshots                                                                                                                  |
| Mutation testing                | `@mizchi/mutator` 0.4.x                                                                                                                                                                      |
| Property-based testing          | fast-check, in a restricted process (permission model; project code is trusted, [ADR 0011](/adr/0011-trusted-project-code)), fixed seeds                                                     |
| Z3 checks                       | Bounded integer/boolean subset (see below), `z3-solver` (WASM), run in its own process                                                                                                       |
| Lean checks                     | Lean 4 with Lake when installed; proofs using `sorry`, `admit`, `native_decide` or extra axioms are rejected                                                                                 |
| Assessment and findings         | Evidence vectors; no single score                                                                                                                                                            |
| Improvement                     | `improve` plans new test files only; applying needs the plan id and approval token, runs in an isolated copy and rolls back unless mutation results improve; refused in CI                   |
| Reports                         | text, JSON, Markdown, self-contained HTML and SARIF 2.1.0                                                                                                                                    |
| CLI                             | The commands in the [CLI reference](/reference/cli)                                                                                                                                          |
| MCP server                      | Read-only tools; applying an approved improvement plan only with `--allow-write`                                                                                                             |
| GitHub Action                   | Offline engine for `pull_request`, incremental with `since`; see [GitHub Action](/reference/github-action)                                                                                   |
| Agent Skill                     | `skills/veritas/SKILL.md`; see [Agents and MCP](/guide/agents)                                                                                                                               |

## Formal subset

| Construct                                                                                                                                             | Supported                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Parameters/results of type `number` (as bounded safe integers) or `boolean`                                                                           | Yes                                                  |
| Record parameters: object types (literal, `interface` or `type` in the same file) whose properties are all `number` or `boolean`; read as `p.field`   | Yes (not as results)                                 |
| Array parameters (`number[]`, `boolean[]`, `readonly`, `Array<T>`) up to `formal.maxArrayLength` elements; `xs.length` and `xs[k]` with a literal `k` | Yes (not as results)                                 |
| Nested records, optional properties, passing or returning a record/array, computed indexes, array methods, spread                                     | Unsupported                                          |
| `if`/`else`, ternary, `return`, `const`                                                                                                               | Yes                                                  |
| `+ - *`, comparisons, `=== !==`, `&&`, `\|\|`, `!`, unary `-`                                                                                         | Yes                                                  |
| Calls to other supported functions in the same file                                                                                                   | Yes (no recursion; not with record/array parameters) |
| `/`, `%`, `**`, floats, `NaN`, `Infinity`, `==`, `??`, casts                                                                                          | Unsupported                                          |
| Loops, `let`/`var`, side effects, async, generators, `this`, external state                                                                           | Unsupported                                          |

Lean proofs cover integer and boolean parameters only; a property over records or arrays is `unsupported` with the Lean backend. Property-based tests draw inputs from the same subset (bounded integers, booleans, and records and arrays of them); strings, floats, `NaN`, `Infinity` and Unicode text are never generated.

## Environments

| Item        | Supported                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js     | 24 or later; project code runs only under Node.js 25+ (network blocked), unless `sandbox.allowNetworkWithoutIsolation` is set: the running Node.js, `VERITAS_SANDBOX_NODE` or `node` on PATH                                         |
| OS          | Linux, macOS, Windows                                                                                                                                                                                                                |
| Test runner | Vitest. Mutation testing needs Vitest 4 or later: `@mizchi/mutator` declares Vitest 5 and also runs Vitest 4 projects, with a warning. On Vitest 3 and earlier, `mutate` is reported as `unsupported` and the other stages still run |
| Languages   | TypeScript, JavaScript (ESM)                                                                                                                                                                                                         |

## External tools and licenses

Veritas is licensed under Apache-2.0. It uses these external tools:

| Tool                          | License    | How it is used                                       |
| ----------------------------- | ---------- | ---------------------------------------------------- |
| `@mizchi/mutator`             | MIT        | npm dependency, run as a separate process            |
| `z3-solver` (Z3)              | MIT        | npm dependency, WASM build                           |
| fast-check                    | MIT        | npm dependency, run in a restricted process          |
| Lean 4 and Lake               | Apache-2.0 | Installed separately by the user (elan); not bundled |
| `openai`                      | Apache-2.0 | npm dependency of the optional OpenAI adapter        |
| `@anthropic-ai/sdk`           | Apache-2.0 | npm dependency of the optional Claude adapter        |
| lightningcss (through Vitest) | MPL-2.0    | Unmodified transitive dependency; never bundled      |
