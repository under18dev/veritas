# Getting started

This page installs Veritas in an existing project, checks the environment and runs the pipeline once.

## Requirements

| Item                     | Requirement                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js                  | 24 or later to run Veritas                                                                                                                                                                                                                 |
| Node.js for project code | 25 or later (26 recommended). Property-based tests and counterexample replay call project functions only under a Node.js that can block their network access. Veritas uses the running Node.js, `VERITAS_SANDBOX_NODE` or `node` on `PATH` |
| Test runner              | Vitest, installed in the project                                                                                                                                                                                                           |
| Language                 | TypeScript or JavaScript (ESM)                                                                                                                                                                                                             |
| OS                       | Linux, macOS or Windows                                                                                                                                                                                                                    |
| Optional                 | git (for `--since` and commit metadata), Lean 4 with Lake installed through [elan](https://github.com/leanprover/elan) for `prove --engine lean`                                                                                           |

Z3 (the `z3-solver` WebAssembly build), `@mizchi/mutator` and fast-check are dependencies of the package; nothing else needs to be installed.

With Node.js 24, Veritas still runs, but property-based tests and counterexample replay are not run and the affected results stay inconclusive.

## Install

::: code-group

```bash [npm]
npm install -D @under18dev/veritas
```

```bash [pnpm]
pnpm add -D @under18dev/veritas
```

```bash [yarn]
yarn add -D @under18dev/veritas
```

```bash [bun]
bun add -d @under18dev/veritas
```

:::

The package provides two commands, `veritas` and `veritas-mcp`. Run them with `npx veritas`, `pnpm exec veritas`, `yarn veritas` or `bunx veritas`. The examples in this guide write `veritas` for short.

```bash
npx veritas --version
```

## Create the configuration

```bash
npx veritas init --yes
```

```text
wrote /path/to/project/.veritas/config.json
detected: package manager=unknown, tsconfig=none, vitest=5.1.1, git=true
next:
  veritas doctor
  veritas discover --offline
  veritas run --profile quick --offline
```

`init` detects the package manager, `tsconfig.json`, Vitest and git, and writes `.veritas/config.json`. It refuses to overwrite an existing file unless you pass `--force`; `--dry-run` prints the configuration without writing it. It fails with `VITEST_NOT_FOUND` when the project does not use Vitest.

The defaults keep network sources off, the LLM off, and formal checks within the integer domain `[-10000, 10000]`. The [configuration reference](/reference/configuration) lists every setting.

## Check the environment

```bash
npx veritas doctor
```

`doctor` reports each tool as `available`, `degraded`, `unavailable` or `disabled`, and then which features are enabled and what they are missing. An excerpt:

```text
available   node             26.13.1 Node.js >= 24
available   vitest           5.1.1 resolved from project
available   mutator          0.4.5 @mizchi/mutator resolved from project
disabled    llm               no LLM provider configured; rule-based analysis only
disabled    network           network access disabled (default)
available   sandbox           restricted process (permission model; defence in depth, the project's code is trusted): no writes, child processes or network

enabled   init
degraded  discover (missing: network, llm)
enabled   mutate
```

`degraded` with `network` and `llm` missing is the normal state: both are optional and off by default.

## Run the pipeline

```bash
npx veritas run --profile standard
```

| Profile    | Stages                                             | Runs project code        |
| ---------- | -------------------------------------------------- | ------------------------ |
| `quick`    | Discovery, code and test analysis, assessment      | No                       |
| `standard` | `quick` plus mutation testing (the default)        | Yes, the project's tests |
| `deep`     | `standard` plus property-based tests and Z3 checks | Yes, tests and functions |

Useful options:

- `--offline`: Veritas itself makes no network request (no web or GitHub sources, no LLM). The project's own tests still run as `pnpm test` would.
- `--include-proposed`: also check properties nobody has accepted yet. Their results stay `suspected`.
- `--since <ref>`: limit mutation testing to what changed since a git ref.

The command prints the stages, the verdict and the findings, and exits with `0` (success, possibly with warnings), `1` (confirmed policy failure), `2` (configuration or usage error), `3` (tool error) or `4` (inconclusive under a `fail` policy). See [Reading results](/guide/reading-results).

## Where the results go

Each run writes a directory `.veritas/runs/<run-id>/`:

| File                                 | Contents                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `run.json`                           | Command, options, stages, verdict, exit code                              |
| `evidence.json`                      | Collected sources with provenance                                         |
| `properties.json`                    | Properties and their review status                                        |
| `test-map.json`, `assessments.json`  | Tests, their links to properties, evidence vectors                        |
| `mutation.json`                      | Mutants and their status                                                  |
| `pbt.json`, `claims.json`, `proofs/` | Property-based tests, formal claims, SMT and Lean files (`deep`, `prove`) |
| `findings.json`                      | Findings                                                                  |
| `report.{json,md,html,sarif}`        | Reports                                                                   |
| `trace.jsonl`                        | Event trace for debugging                                                 |

`veritas report` prints the latest run again; `veritas explain <finding-id>` prints the evidence chain of one finding.

Decisions about specifications go to `.veritas/approvals.json`. A `.gitignore` that keeps the configuration and decisions but not the runs and caches:

```text
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

`.mutator/` is the working directory of the mutation tool.

## Next steps

- [Tutorial](/guide/tutorial): a full walk-through on a small project with a boundary bug.
- [Reading results](/guide/reading-results): verdicts, findings, test outcomes and statuses.
- [Specifications](/guide/specifications): review and accept what Veritas found in your docs.
- [CI and GitHub Action](/guide/ci): run Veritas on pull requests.
