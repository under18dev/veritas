# Support matrix

What works in the current build. Planned items are listed separately and are not available yet.

## Available now

| Area                                                                                                                                | Status                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `veritas init` (`--yes`, `--force`, `--dry-run`)                                                                                    | Available                                               |
| `veritas doctor` (`--json`)                                                                                                         | Available                                               |
| Configuration: `.veritas/config.json` with validation; `veritas.config.ts/js` with `--allow-code-config`                            | Available                                               |
| Artifact store, JSON Schemas (`schemas/`)                                                                                           | Available                                               |
| Other commands (`discover`, `spec`, `analyze`, `mutate`, `test generate`, `prove`, `improve`, `report`, `run`, `replay`, `explain`) | Registered; exit 3 with `unsupported` until implemented |

## Environments

| Item        | Supported                         |
| ----------- | --------------------------------- |
| Node.js     | 24 or later                       |
| OS          | Linux, macOS, Windows (CI matrix) |
| Test runner | Vitest                            |
| Languages   | TypeScript, JavaScript (ESM)      |

## Planned

Evidence discovery, code intelligence, property registry, test mapping, mutation (`@mizchi/mutator`), property-based testing (fast-check), Z3 and Lean backends, assessment, improvement loop, reports (Markdown, HTML, SARIF), MCP server, Agent Skill, GitHub Action.
