# Getting started

Install Veritas in your project, check the environment and run the pipeline once. For a guided example with a known bug, follow the [tutorial](/guide/tutorial).

## Requirements

| Item                          | Requirement                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                       | 24 or later                                                                                                                           |
| Node.js for your project code | 25 or later (26 recommended) for property-based tests and counterexample replay, which run your functions with network access blocked |
| Test runner                   | Vitest, installed in the project                                                                                                      |
| Language                      | TypeScript or JavaScript (ESM)                                                                                                        |
| OS                            | Linux, macOS or Windows                                                                                                               |
| Optional                      | git, for `--since` and commit metadata; Lean 4 and Lake through [elan](https://github.com/leanprover/elan), for `prove --engine lean` |

Z3, `@mizchi/mutator` and fast-check come with the package.

For property-based tests and counterexample replay, Veritas uses the Node.js it runs on, then `VERITAS_SANDBOX_NODE`, then `node` on `PATH`. If none of them is 25 or later, those checks do not run and their results are reported as inconclusive.

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

The package provides two commands, `veritas` and `veritas-mcp`. Run them through your package manager (`npx veritas`, `pnpm exec veritas`, `yarn veritas`, `bunx veritas`). Most pages in this guide write `veritas` for short.

To use Veritas without adding it to each project, install it globally:

```bash
npm install -g @under18dev/veritas
```

This puts `veritas` and `veritas-mcp` on your `PATH`. When you run it in a project, Vitest, `@mizchi/mutator` and fast-check are taken from the project if it has them installed. The copy of `@mizchi/mutator` that comes with Veritas runs the project's Vitest, but loads some of its own files from where Veritas is installed. If mutation testing reports that your tests fail without mutants while they pass on their own, add `@mizchi/mutator` to the project too (`npm install -D @mizchi/mutator`).

## Create the configuration

```bash
npx veritas init --yes
```

```text
wrote /path/to/project/.veritas/config.json
detected: package manager=npm, tsconfig=none, vitest=5.1.1, git=true
next:
  veritas doctor
  veritas discover --offline
  veritas run --profile quick --offline
```

| Option      | Effect                                       |
| ----------- | -------------------------------------------- |
| `--yes`     | Accept the detected configuration            |
| `--force`   | Overwrite an existing `.veritas/config.json` |
| `--dry-run` | Print the configuration without writing it   |

`init` stops with `VITEST_NOT_FOUND` if the project does not use Vitest. The default configuration turns network sources and LLMs off and uses the integer domain `[-10000, 10000]` for formal checks. Every setting is listed in the [configuration reference](/reference/configuration).

### Answer the questions in a terminal

Without `--yes`, `init` run in a terminal asks about the settings it cannot detect. Pressing Enter keeps the default for each question, so nothing changes unless you say yes.

| Question                                                       | What a yes does                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM provider                                                   | Sets `llm.provider` (`claude`, `claude-code`, `codex` or `openai`); each is marked as available or not set up. `codex` also needs your permission for its read-only shell to read local files (`llm.allowCodexFileReads`) |
| GitHub issues and pull requests                                | Turns on `sources.github` for the repository (the `origin` remote is offered); read only in runs without `--offline`                                                                                                      |
| Web pages                                                      | Turns on `sources.web` for the domains you list; fetched only in runs without `--offline`                                                                                                                                 |
| Install Lean 4 (only when it is missing)                       | Downloads the official elan installer from GitHub and installs the stable Lean 4 toolchain into `~/.elan`, where `veritas doctor` looks                                                                                   |
| Use Lean instead of Z3                                         | Sets `formal.backend` to `lean`. Lean covers integers and booleans only; Z3 also covers records and arrays                                                                                                                |
| Add `@mizchi/mutator` to the project (only when it is missing) | Runs your package manager to add it as a dev dependency, so mutation testing loads all of mutator's files from the project instead of from where Veritas is installed                                                     |

You then see the resulting configuration and confirm writing it. Installs run only after that confirmation; if Lean cannot be installed, proofs stay on Z3. With `--json` or in CI, these questions are skipped and nothing is installed; `init` still asks before writing the detected configuration. `--yes` writes it without asking, and is required without a terminal.

## Check the environment

```bash
npx veritas doctor
```

```text
available   node             26.13.1 Node.js >= 24
available   git              git version 2.50.1 (Apple Git-155) git repository detected
available   package_manager  npm detected from lockfile
available   typescript       6.0.3 resolved from project
available   vitest           5.1.1 resolved from project
available   mutator          0.4.5 @mizchi/mutator resolved from project
available   fast_check       4.10.3 resolved from project
available   z3               5.4.1 z3-solver (wasm) resolved from project
[...]
disabled    llm               no LLM provider configured; rule-based analysis only
disabled    network           network access disabled (default)
available   sandbox           restricted process (permission model; defence in depth, the project's code is trusted): no writes, child processes or network

enabled   init
degraded  discover (missing: network, llm)
degraded  analyze (missing: llm)
enabled   mutate
[...]
enabled   prove (z3)
```

The first part lists each tool as `available`, `degraded`, `unavailable` or `disabled`. The second part lists each command and what it is missing. `degraded` because of `network` and `llm` is the default state: both are optional.

## Run the pipeline

```bash
npx veritas run --profile standard
```

| Profile    | What runs                                             | Executes your code       |
| ---------- | ----------------------------------------------------- | ------------------------ |
| `quick`    | Source collection, code and test analysis, assessment | No                       |
| `standard` | `quick` plus mutation testing (default)               | Your tests               |
| `deep`     | `standard` plus property-based tests and Z3 checks    | Your tests and functions |

| Option               | Effect                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `--offline`          | Veritas makes no network requests (no web or GitHub sources, no LLM). Your tests run as with `npm test` |
| `--include-proposed` | Also check properties nobody has accepted; their results stay `suspected`                               |
| `--since <ref>`      | Mutation-test only what changed since a git ref                                                         |

The command prints each stage, the verdict and the findings, and exits with `0` (success, possibly with warnings), `1` (confirmed policy failure), `2` (configuration or usage error), `3` (tool error) or `4` (inconclusive under a `fail` policy). [Reading results](/guide/reading-results) explains the output.

## Find the results

Each run writes `.veritas/runs/<run-id>/`. `veritas report` prints the latest run again and `veritas explain <finding-id>` prints the evidence behind one finding. The files are described in [Reports and artifacts](/reference/reports).

Decisions about specifications are stored in `.veritas/approvals.json`. Keep the configuration and the decisions in version control and ignore the rest:

```text
.veritas/*
!.veritas/config.json
!.veritas/approvals.json
.mutator/
```

`.mutator/` is the working directory of the mutation tool.

## Next steps

- [Tutorial](/guide/tutorial): find and fix a boundary bug in a small project.
- [Terminal UI](/guide/tui): run `veritas` without arguments to do the same steps interactively.
- [Specifications](/guide/specifications): accept or reject the rules Veritas found.
- [CI and GitHub Action](/guide/ci): run Veritas on pull requests.
