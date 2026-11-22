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
| Test inventory                  | Vitest and Jest `it`/`test`/`describe` incl. modifiers, assertions, mocks, snapshots; Jest's globals, `@jest/globals` and `jest.*` mocks                                                     |
| Mutation testing                | `@mizchi/mutator` 0.4.x; with Jest it is experimental (see below)                                                                                                                            |
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

| Construct                                                                                                                                                                           | Supported            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Parameters/results of type `number` (as bounded safe integers) or `boolean`                                                                                                         | Yes                  |
| Record parameters: object types (literal, `interface` or `type` in the same file) whose properties are all `number` or `boolean`; read as `p.field`                                 | Yes (not as results) |
| Array parameters (`number[]`, `boolean[]`, `readonly`, `Array<T>`) up to `formal.maxArrayLength` elements; `xs.length` and `xs[k]` with a literal `k`                               | Yes (not as results) |
| Passing a record to a function in the same file: a record parameter with exactly the same fields, or an object literal listing each field once (`g({ total: o.total, vip: true })`) | Yes                  |
| Passing an array parameter with the same element type to a function in the same file                                                                                                | Yes                  |
| Nested records, optional properties, returning or copying a record/array, extra or missing fields, spread, computed keys, array literals, computed indexes, array methods           | Unsupported          |
| `if`/`else`, ternary, `return`, `const`                                                                                                                                             | Yes                  |
| `+ - *`, comparisons, `=== !==`, `&&`, `\|\|`, `!`, unary `-`                                                                                                                       | Yes                  |
| Calls to other supported functions in the same file                                                                                                                                 | Yes (no recursion)   |
| `/`, `%`, `**`, floats, `NaN`, `Infinity`, `==`, `??`, casts                                                                                                                        | Unsupported          |
| Loops, `let`/`var`, side effects, async, generators, `this`, external state                                                                                                         | Unsupported          |

Lean proofs cover integer, boolean and record parameters; a property over arrays is `unsupported` with the Lean backend. Property-based tests draw inputs from the same subset (bounded integers, booleans, and records and arrays of them); strings, floats, `NaN`, `Infinity` and Unicode text are never generated.

## Environments

| Item         | Supported                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js      | 24 or later; project code runs only under Node.js 25+ (network blocked), unless `sandbox.allowNetworkWithoutIsolation` is set: the running Node.js, `VERITAS_SANDBOX_NODE` or `node` on PATH |
| OS           | Linux, macOS, Windows                                                                                                                                                                        |
| Test runner  | Vitest or Jest, set by `analysis.testFramework` (`veritas init` detects it). See [Test runners](#test-runners)                                                                               |
| Dependencies | Installed in `node_modules` (npm, pnpm, Yarn with `nodeLinker: node-modules`, Bun). Yarn Plug'n'Play is not supported                                                                        |
| Languages    | TypeScript, JavaScript (ESM)                                                                                                                                                                 |

## Test runners

| Runner | Detected from                                                                                                    | Tests run with                                               | Mutation testing                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest | `vitest.config.*`, `vitest` in package.json, a test script that runs `vitest`                                    | `vitest run` with the JSON reporter                          | Needs Vitest 4 or later: `@mizchi/mutator` declares Vitest 5 and also runs Vitest 4 projects, with a warning. On Vitest 3 and earlier, `mutate` is reported as `unsupported` and the other stages still run                                                                 |
| Jest   | `jest.config.{js,ts,mjs,cjs,cts,json}`, a `"jest"` key or `jest` in package.json, a test script that runs `jest` | `jest --json`, started with `node --experimental-vm-modules` | Experimental, as `@mizchi/mutator` marks its Jest support: Jest 30, native ESM projects only (`"type": "module"`), no Jest `projects`. Other projects get `unsupported` with the reason. `doctor` shows the mutator as `degraded`, and every mutation run carries a warning |

When a project shows more than one runner, `init` prefers one it can run: an installed runner over one that is only declared, and either over one that only a config file or a package.json key points at, so a Jest config left from a migration does not win over an installed Vitest. Among equals it takes the one the `test` script runs (as a command, not a word in an argument), then the only one with a config file or a dependency. If nothing tells them apart, it chooses Vitest, says so, and (in a terminal) asks. A configuration without `analysis.testFramework` means Vitest.

With Jest, what `jest.mock` does depends on how the tests run. Babel and ts-jest compile them to CommonJS and hoist `jest.mock` above the imports, so it replaces the module and Veritas records a mock. In native ES modules (`"type": "module"` with no Babel config, no compiling transformer, and a Jest config whose `transform` is absent or empty and that has no `preset`; when in doubt, Veritas keeps counting `jest.mock` as a mock) the static imports are bound before `jest.mock` runs and the tests reach the real code, so Veritas does not count it as a mock of them; `jest.unstable_mockModule` followed by a dynamic `import()` is the ESM way, and what such an import loads is reported as unknown.

Tests marked to pass only when they fail (Vitest's `it.fails`, Jest's `it.failing`) get the `expected_failure` modifier and are always assessed as `inconclusive`: their kills and survivors mean the opposite of what their assertions read as.

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
