# What is Veritas?

Veritas checks what the Vitest or Jest tests of a TypeScript or JavaScript project actually guarantee. It reads the rules your project already documents (README, `docs/`, JSDoc, OpenAPI and JSON Schema, git history, exported issues), links them to your code and tests, runs mutation testing, property-based tests and bounded formal checks, and reports each finding together with its evidence.

## The problem it addresses

A passing test suite tells you that the tests pass, not what they check. For example:

- a test asserts `expect(true).toBe(true)` and never calls your code;
- a test calls your code but never uses the boundary input your documentation describes;
- the README says "1000 or more", the code says `total > 1000`, and every test passes because none uses 1000.

In the second and third case every line runs, so line coverage counts the code as covered. Veritas reports all three as findings.

## What you get for each test and rule

| Question                                            | Evidence in the report                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| Which documented rule does this test relate to?     | The quoted source line (file and line) and the property built from it    |
| What does the test check?                           | The project functions it calls and the results it asserts                |
| Which faults would it catch?                        | The mutants it kills and the mutants that survive it                     |
| What was checked formally, and within which bounds? | Z3 or Lean results with their input domain, assumptions and solver files |
| What is still unknown?                              | Undecided, unsupported and skipped checks, listed by name                |

## What Veritas does not do

- There is no score. Each test gets an evidence vector and one of five outcomes ([Reading results](/guide/reading-results)).
- Veritas does not prove your code correct. `proven_within_model` means that no counterexample exists within the stated model, bounds and assumptions ([Verification](/guide/verification)).
- Deciding what the specification is stays with you. No rule Veritas finds becomes `accepted` unless you accept it, and it never changes a specification or an expected value to match the code ([Specifications](/guide/specifications)).
- Your project's code is not isolated: Veritas runs your tests and functions with the same trust as `npm test` ([Untrusted repositories](/guide/untrusted-repositories)).

## How a run works

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

1. Veritas collects sources and keeps the file and line of every statement.
2. It turns statements such as "Orders with a total of 1000 or more receive a flat discount of 100" into properties of one function and one parameter. It also infers candidate properties from the code; those are hypotheses, not specifications.
3. It finds your tests (Vitest or Jest) and what they call and assert.
4. Mutation testing, property-based tests and Z3 or Lean produce evidence about each property.
5. The assessment engine produces per-test evidence vectors, findings, a verdict and an exit code.
6. On request, the improvement planner proposes new test files whose expected values come from accepted properties.

[Architecture](/concepts/architecture) describes the packages behind each step.

## Ways to run it

All entry points use the same engine. Each command writes the artifacts of the stages it runs to `.veritas/runs/<run-id>/`; commands that include the report stage (`veritas run` and `veritas prove`) also write the reports listed in `reports.formats` (by default JSON, Markdown, HTML and SARIF).

| Entry point   | Use it for                          | Start here                                                                 |
| ------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| CLI `veritas` | Local use and any CI system         | [Getting started](/guide/getting-started), [CLI reference](/reference/cli) |
| Node API      | Calling Veritas from your own tools | [Node API](/reference/api)                                                 |
| MCP server    | Agents that use MCP (`veritas-mcp`) | [Agents and MCP](/guide/agents)                                            |
| Agent Skill   | Agents that load `SKILL.md` files   | [Agents and MCP](/guide/agents)                                            |
| GitHub Action | Checks on pull requests             | [CI and GitHub Action](/guide/ci)                                          |

Veritas makes no network requests unless you enable network sources or an LLM provider.
