# Architecture

Veritas answers, for each test, which specification it is derived from, what it observes, which faults it detects, what has been formally checked under which model and bounds, and what remains unknown. The evidence for each answer is written to machine-readable files. Below, a run is followed through the packages of Veritas, along with where it stores its data. For what the results mean, see [Semantics](/concepts/semantics).

## Pipeline

```text
CLI / Node API / Agent Skill / MCP / GitHub Action
                       |
               Orchestrator (engine)
                       |
    +------------------+-------------------+
Evidence collectors  Code intelligence  Test inventory
    +---------- Specification engine ------+
                        |
                 Property registry
       +----------------+------------------+
 Mutation adapter  Property-based tests  Formal adapter
   (mutator)          (fast-check)        (Z3 / Lean)
       +----------------+------------------+
                 Assessment engine
                        |
               Improvement planner
                        |
        Artifact store / reporters / CI policy
```

## Packages

| Package                    | Responsibility                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                     | Domain schemas, Property IR, artifact store, cache, IDs, policy, exit codes, process runner, path safety, redaction, project detection, `init`/`doctor`                          |
| `cli`                      | `veritas` and `veritas-mcp` executables, published as `@under18dev/veritas`; parses arguments and calls package APIs                                                             |
| `engine`                   | Orchestrator and Node API: runs stages, persists run artifacts, reports, `explain`, spec helpers; shared by the CLI, MCP server and GitHub Action                                |
| `spec-discovery`           | Evidence collectors (local, GitHub, web), provenance graph, normative statement extraction                                                                                       |
| `code-intelligence`        | TypeScript analysis: exports, signatures, branches, boundaries, side effects                                                                                                     |
| `property-engine`          | Property registry, review state machine, conflicts, approvals                                                                                                                    |
| `test-inventory`           | Vitest test discovery, assertion analysis, test-symbol-property graph                                                                                                            |
| `mutation-adapter`         | Runs the mutation backend and normalizes results                                                                                                                                 |
| `property-testing`         | fast-check generators, seeds, shrinking, replay                                                                                                                                  |
| `formal-core`              | TypeScript subset to Property IR, claims, semantic validation                                                                                                                    |
| `solver-z3`, `solver-lean` | Solver backends                                                                                                                                                                  |
| `assessment`               | Evidence vectors and test outcomes                                                                                                                                               |
| `improvement`              | Plans, approved patches in isolated workspaces, rollback                                                                                                                         |
| `llm`, `llm-providers/*`   | Provider-neutral LLM interface and one adapter per provider: `llm-providers/claude` (Anthropic API), `claude-code` (Claude Code CLI), `openai` (OpenAI API), `codex` (Codex CLI) |
| `reports`                  | Text, JSON, Markdown, HTML, SARIF                                                                                                                                                |
| `mcp`                      | MCP server                                                                                                                                                                       |
| `github-action`            | CI integration                                                                                                                                                                   |

What each part supports is listed in the [support matrix](/concepts/support-matrix).

## How the pieces fit

- The CLI, the Node API, the MCP server and the GitHub Action call the same package functions. A command and its API function or MCP tool run the same stages and write the same files; for example, `veritas analyze`, `analyze()` and the `analyze_tests` tool.
- Each stage reports its own result. A stage that throws ends as `error`, stages that depend on a failed stage are `skipped`, and no stage reports success for another one.

## Storage

| Path                                                                                | Content                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `.veritas/config.json` (or `veritas.config.{ts,mjs,js}` with `--allow-code-config`) | Configuration                                                                                                  |
| `.veritas/approvals.json`                                                           | Human decisions on properties: who, when, what, why                                                            |
| `.veritas/runs/<run-id>/`                                                           | Per-run artifacts: evidence, properties, test map, mutants, solver input/output, patches, reports              |
| `.veritas/cache/`                                                                   | Content-addressed cache of decisive solver results, LLM responses and mutation runs; ignored if tracked by git |
| `.veritas/improvements/<plan-id>/`                                                  | Improvement plans, approvals and apply attempts                                                                |
| `.veritas/generated-tests/`                                                         | Property-based test files written by `veritas test generate`                                                   |

Each JSON artifact is an envelope with `schemaVersion`, `runId`, `createdAt`, `toolVersion`, `gitCommit`, `configHash` and `sourceHash` ([ADR 0002](/adr/0002-schemas-and-artifacts)). Files that cannot hold an envelope (solver input and output, Lean sources, rendered reports, the mutator's own report files) are listed in `artifact-index.json` with their SHA-256, and that index carries the metadata; the rendered reports also show it. JSON Schemas are in `schemas/`. See [Reports and artifacts](/reference/reports) for every file of a run.

## Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Success                                                                       |
| 1    | Confirmed policy failure                                                      |
| 2    | Invalid configuration or user error                                           |
| 3    | Tool or infrastructure error (including commands not available in this build) |
| 4    | Inconclusive under the configured policy                                      |

With `--json`, stdout carries only JSON; logs go to stderr. See the [CLI reference](/reference/cli#exit-codes) for verdicts.
