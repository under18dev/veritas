# Threat model

## Assets

The user's source tree and git state, credentials in the environment (API keys, `GITHUB_TOKEN`), CI secrets, and the integrity of Veritas's claims.

## Untrusted inputs

Repository content (code, docs, tests, configs), Issues and PRs, web pages, LLM output, mutation and solver output, and pull requests from forks.

## Threats and controls

| Threat                                        | Control                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in docs, Issues or web pages | Collected text is stored as data with `trust: untrusted_data`; it never selects tools, commands or policy. LLM prompts quote it as data.                                                    |
| Path traversal and symlink escape             | All writes go through `resolveInsideRoot`, which rejects `..`, absolute escapes, NUL bytes and symlinks resolving outside the root.                                                         |
| Argument and shell injection                  | Child processes are spawned without a shell, with argument arrays.                                                                                                                          |
| Secret leakage                                | Child processes receive an allowlisted environment. Artifacts, logs and reports are redacted (token patterns and secret-named environment values). Full prompts are not stored by default.  |
| Code execution through configuration          | `veritas.config.ts/js` is loaded only with `--allow-code-config`; JSON config is the default.                                                                                               |
| Unapproved writes                             | `init` refuses to overwrite without `--force`. `improve` is dry-run by default; applying needs approval and runs in an isolated copy with rollback. MCP write tools need an approval token. |
| SSRF and uncontrolled network access          | Network sources are off by default; the web collector uses a domain allowlist and page, depth, size and time budgets.                                                                       |
| Resource exhaustion                           | Timeouts and output caps on child processes and solvers; budgets on mutants, tokens and iterations.                                                                                         |
| Fork pull requests in CI                      | The Action runs read-only, does not expose secrets to fork code, and does not run PR code with elevated permissions.                                                                        |
| Fabricated or overstated results              | Solver, mutation and test results come only from real runs; `unknown`, `timeout` and `unsupported` are never success.                                                                       |

## Out of scope

Malicious code in the analysed project that runs during the user's own test execution (Vitest, mutation runs) is contained only by the isolation that the runner and the OS provide; Veritas runs those steps in temporary workspaces with a restricted environment but is not a security sandbox against hostile code.
