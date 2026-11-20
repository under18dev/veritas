# What is Veritas?

Veritas checks what the tests of a TypeScript or JavaScript project actually guarantee. It reads the specification the project already has (README, docs, JSDoc, OpenAPI and JSON Schema, git history, exported issues), relates it to the code and the Vitest tests, runs mutation testing, property-based tests and bounded formal checks, and reports every finding together with the evidence behind it.

## The problem

A green test suite says that the tests pass. It does not say what they check. Common cases:

- A test asserts a constant (`expect(true).toBe(true)`) and never calls the code.
- A test calls the code but never tries the boundary the documentation describes, so `>` and `>=` behave the same for every input it uses.
- The documentation says "1000 or more" and the code says `total > 1000`. Every test passes, because no test uses 1000.

Coverage does not catch these: the lines run, but nothing checks the result at the input that matters.

## What Veritas answers

For each test and each specification statement, Veritas answers five questions:

| Question                                             | Evidence Veritas uses                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Which specification is this test derived from?       | The quoted source line (file and line), the property built from it      |
| What does the test observe?                          | Its calls to project functions and its assertions, from static analysis |
| Which faults would it catch?                         | Mutants it kills and mutants that survive it, from a real mutation run  |
| What has been checked formally, within which bounds? | Z3 or Lean claims with their domain, assumptions and solver input files |
| What is still unknown?                               | Anything undecided, unsupported or not run, listed explicitly           |

## What Veritas is not

- **Not a score.** There is no "87% good". Each test gets an evidence vector and one of five outcomes; see [Reading results](/guide/reading-results).
- **Not a proof of correctness.** `proven_within_model` means "no counterexample within the stated model, bounds and assumptions". Inputs outside the bounds, floats, `NaN` and anything outside the supported subset are not covered. See [Verification](/guide/verification).
- **Not a judge of the specification.** Veritas never changes a specification or an expected value to match the implementation, and never accepts a specification on its own. People decide; see [Specifications](/guide/specifications).
- **Not a sandbox.** Veritas runs the project's tests and functions with the same trust as `pnpm test`. For code you do not trust, see [Untrusted repositories](/guide/untrusted-repositories).

## How it works

```text
CLI / Node API / Agent Skill / MCP server / GitHub Action
                       |
                  Orchestrator
                       |
    +------------------+-------------------+
Evidence collectors  Code intelligence  Test inventory
 (README, docs, ...)  (TypeScript API)    (Vitest tests)
    +---------- Specification engine ------+
                       |
                Property registry
         (proposed -> accepted | rejected ...)
       +---------------+-------------------+
 Mutation testing  Property-based tests  Formal checks
   (mutator)          (fast-check)       (Z3 / Lean 4)
       +---------------+-------------------+
                Assessment engine
       (evidence vectors, findings, verdict)
                       |
               Improvement planner
                       |
       Artifacts / reports / CI exit codes
```

1. Evidence collectors read local sources (and, only when enabled, GitHub and the web) and keep each source with its file and line.
2. The specification engine turns statements such as "Orders with a total of 1000 or more receive a flat discount of 100" into properties bound to a function and a parameter. Code intelligence adds properties inferred from the code itself; those stay hypotheses.
3. The test inventory finds Vitest tests and what they call and assert.
4. Mutation testing, property-based tests and Z3 or Lean checks produce evidence about the properties.
5. The assessment engine combines everything into per-test evidence vectors, findings and a policy verdict with an exit code.
6. The improvement planner can propose new test files whose expected values come from accepted specifications.

The [architecture page](/concepts/architecture) describes the packages behind each box.

## Surfaces

All entry points run the same engine and produce the same artifacts.

| Surface       | Use it for                               | Where to start                                                             |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| CLI `veritas` | Local use and any CI system              | [Getting started](/guide/getting-started), [CLI reference](/reference/cli) |
| Node API      | Calling Veritas from your own tooling    | [Node API](/reference/api)                                                 |
| MCP server    | Agents that speak MCP (`veritas-mcp`)    | [Agents and MCP](/guide/agents)                                            |
| Agent Skill   | Agents that load `SKILL.md` instructions | [Agents and MCP](/guide/agents)                                            |
| GitHub Action | Pull request checks                      | [CI and GitHub Action](/guide/ci)                                          |

Network access is off by default. Results are written to `.veritas/runs/<run-id>/` as JSON, Markdown, HTML and SARIF.
