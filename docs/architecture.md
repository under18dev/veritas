# Architecture

Veritas answers, for each test, which specification it is derived from, what it observes, which faults it detects, what has been formally checked under which model and bounds, and what remains unknown. Every answer is backed by machine-readable evidence.

## Pipeline

```text
CLI / Node API / Agent Skill / MCP / GitHub Action
                       |
                 Orchestrator (runStages)
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

| Package                    | Responsibility                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                     | Domain schemas, Property IR, artifact store, cache, IDs, policy, exit codes, process runner, path safety, redaction, project detection, `init`/`doctor` |
| `cli`                      | `veritas` executable; parses arguments and calls package APIs                                                                                           |
| `spec-discovery`           | Evidence collectors (local, GitHub, web), provenance graph, normative statement extraction                                                              |
| `code-intelligence`        | TypeScript analysis: exports, signatures, branches, boundaries, side effects                                                                            |
| `property-engine`          | Property registry, review state machine, conflicts, approvals                                                                                           |
| `test-inventory`           | Vitest test discovery, assertion analysis, test-symbol-property graph                                                                                   |
| `mutation-adapter`         | Runs the mutation backend and normalizes results                                                                                                        |
| `property-testing`         | fast-check generators, seeds, shrinking, replay                                                                                                         |
| `formal-core`              | TypeScript subset to Property IR, claims, semantic validation                                                                                           |
| `solver-z3`, `solver-lean` | Solver backends                                                                                                                                         |
| `assessment`               | Evidence vectors and test outcomes                                                                                                                      |
| `improvement`              | Plans, approved patches in isolated workspaces, rollback                                                                                                |
| `llm`, `llm-providers/*`   | Provider-neutral LLM interface and one adapter per provider (`llm-providers/claude`)                                                                    |
| `reports`                  | Text, JSON, Markdown, HTML, SARIF                                                                                                                       |
| `mcp`                      | MCP server                                                                                                                                              |
| `github-action`            | CI integration                                                                                                                                          |

Packages appear as they are implemented; see the support matrix for what works today.

## Rules

- `core` depends on no other workspace package, CLI framework or LLM SDK (enforced by dependency-cruiser). No package cycles.
- Every entry point (CLI, Node API, MCP, Action) calls the same package functions and produces the same artifacts.
- Stages run through `runStages`. A thrown error becomes an `error` stage result; dependents of a failed stage are `skipped`; nothing reports success on behalf of another stage.

## Storage

| Path                                            | Content                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `.veritas/config.json` (or `veritas.config.ts`) | Configuration                                                                                     |
| `.veritas/approvals.json`                       | Human decisions on properties: who, when, what, why                                               |
| `.veritas/runs/<run-id>/`                       | Per-run artifacts: evidence, properties, test map, mutants, solver input/output, patches, reports |
| `.veritas/cache/`                               | Content-addressed cache                                                                           |

Each JSON artifact is an envelope with `schemaVersion`, `runId`, `createdAt`, `toolVersion`, `gitCommit`, `configHash` and `sourceHash` (ADR 0002). Files that cannot hold an envelope (solver input and output, Lean sources, rendered reports, the mutator's own report files) are listed in `artifact-index.json` with their SHA-256, and that index carries the metadata; the rendered reports also show it. JSON Schemas are in `schemas/`.

## Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Success                                                                       |
| 1    | Confirmed policy failure                                                      |
| 2    | Invalid configuration or user error                                           |
| 3    | Tool or infrastructure error (including commands not available in this build) |
| 4    | Inconclusive under the configured policy                                      |

With `--json`, stdout carries only JSON; logs go to stderr.
