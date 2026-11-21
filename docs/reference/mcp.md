# MCP server

`veritas-mcp` serves Veritas to MCP clients such as coding agents, and is installed with `@under18dev/veritas`. This reference covers how to start it, each tool with its inputs and results, and how approvals, concurrency and cancellation work. Tools that run stages create a new run in `.veritas/runs/<run-id>/`, like the matching `veritas` command; `list_properties`, `get_evidence` and `get_run_status` read existing runs; `plan_improvement` and `apply_approved_improvement` write under `.veritas/improvements/`. To connect it to a client, see [Agents and MCP](/guide/agents).

## Starting the server

```bash
veritas-mcp [--root <dir>] [--max-concurrent <n>] [--allow-write]
```

| Option                 | Default           | Meaning                                                                            |
| ---------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `--root <dir>`         | current directory | Project root. Every tool works inside it; no tool accepts a path outside it        |
| `--max-concurrent <n>` | `1`               | Long-running operations allowed at the same time (1 to 16)                         |
| `--allow-write`        | off               | Register `apply_approved_improvement`, the only tool that can change project files |
| `-h`, `--help`         |                   | Print the usage and exit                                                           |

An invalid option, a `--max-concurrent` outside 1 to 16, or a `--root` that is not an existing directory ends the process with exit code 2. Once connected, the server writes `veritas-mcp serving <root>` to stderr.

A client configuration that starts the server for one project:

```json
{
  "mcpServers": {
    "veritas": {
      "command": "npx",
      "args": ["veritas-mcp", "--root", "/path/to/project"]
    }
  }
}
```

## Tools

All tools that run stages run **offline**: no GitHub or web sources and no LLM requests, whatever the configuration says. They record the command as `mcp:<tool name>` in `run.json`.

| Tool                         | Registered           | Changes project files | Runs project code                                  |
| ---------------------------- | -------------------- | --------------------- | -------------------------------------------------- |
| `discover_specs`             | always               | no                    | no                                                 |
| `list_properties`            | always               | no                    | no                                                 |
| `analyze_tests`              | always               | no                    | no                                                 |
| `run_mutation`               | always               | no                    | yes (the project's tests)                          |
| `verify_property`            | always               | no                    | yes (counterexample replay, restricted)            |
| `get_evidence`               | always               | no                    | no                                                 |
| `get_run_status`             | always               | no                    | no                                                 |
| `plan_improvement`           | always               | no                    | yes (restricted calls of the functions under test) |
| `apply_approved_improvement` | with `--allow-write` | yes (adds test files) | yes                                                |

All tools except `apply_approved_improvement` are marked read-only (`readOnlyHint`): they do not change project files, but the tools that run stages write a run directory under `.veritas/`.

### `discover_specs`

Collects specification evidence: README, docs, JSDoc, schemas, git history and exported issues. Runs the stages of `veritas discover`.

- Input: none.
- Returns: the run summary (below), plus `sources` (each with `id`, `kind`, `locator`, `range`, `summary` and `trust`), `statements` and `skipped`.

### `list_properties`

Lists the properties of the latest run with the approval ledger applied: review status, origin and sources. Approvals cannot be changed through MCP; use `veritas spec accept` or `veritas spec reject`.

| Input    | Type                                                                         | Required |
| -------- | ---------------------------------------------------------------------------- | -------- |
| `status` | `proposed`, `reviewed`, `accepted`, `rejected`, `conflicted` or `superseded` | no       |

- Returns: `runId` and `properties`, filtered by `status` when given.

### `analyze_tests`

Indexes code and tests, maps tests to properties and assesses each test with an evidence vector, without a mutation run. Runs the stages of `veritas analyze`.

- Input: none.
- Returns: the run summary plus `assessments`.

### `run_mutation`

Runs mutation testing with the real mutator and relates mutants to properties and tests. Runs the stages of `veritas mutate`.

| Input        | Type                                                                                | Required | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `since`      | git ref (letters, digits, `._/@~^-`, at most 200 characters, not starting with `-`) | no       | Limit mutants to the change since this ref                              |
| `scope`      | project-relative path or glob                                                       | no       | Source glob to mutate                                                   |
| `killMatrix` | boolean, default `false`                                                            | no       | Run every covering test for every mutant (slower)                       |
| `reportFile` | project-relative path                                                               | no       | Import this mutation-testing-elements report instead of running mutator |

`reportFile` and `killMatrix` together are refused (`OPTION_CONFLICT`). Paths must stay inside the project: absolute paths, drive letters, `..` segments and leading `-` are rejected.

- Returns: the run summary plus `counts` (mutants by status) and `mutants`.

### `verify_property`

Checks formalized properties within a bounded integer model and replays counterexamples in JavaScript. Runs the stages of `veritas prove`. The backend is `formal.backend` from the configuration (Z3 by default). A result is "proven within the model" at best, never a general proof; see [Semantics](/concepts/semantics).

| Input             | Type                     | Required | Meaning                                                    |
| ----------------- | ------------------------ | -------- | ---------------------------------------------------------- |
| `propertyId`      | `P-<hex>`                | no       | Check only this property                                   |
| `includeProposed` | boolean, default `false` | no       | Also check properties that are not accepted (experimental) |

- Returns: the run summary plus `claims` (empty when no claim was produced).

### `get_evidence`

Returns the evidence chain of a finding, as `veritas explain` does.

| Input       | Type      | Required |
| ----------- | --------- | -------- |
| `findingId` | `F-<hex>` | yes      |

- Returns: `runId`, `finding`, `properties`, `sources`, `statements`, `tests`, `assessments`, `mutants` and `claims`.

### `get_run_status`

Returns the status, stages, verdict and usage of a run.

| Input   | Type       | Required | Meaning                 |
| ------- | ---------- | -------- | ----------------------- |
| `runId` | `run-<id>` | no       | Default: the latest run |

- Returns: `run`, the content of `run.json`.

### `plan_improvement`

Plans test-only improvements from the latest run with findings, like `veritas improve --dry-run`. No project file is changed.

- Input: none.
- Returns: the plan result: `planId`, `runId`, `outcome`, `plan`, `approvalToken`, `specViolationCandidates`, `implementationFixProposals`, `skipped`, `reasons` and `planFile`. `outcome` is `planned` when a plan is ready, otherwise the reason the planner stopped (`no_safe_improvement`, `needs_spec_decision`, `blocked`, `error`).

Only accepted properties supply expected values; proposed ones cannot be used through MCP.

### `apply_approved_improvement`

Registered only with `--allow-write`. Applies a reviewed improvement plan: it adds new test files only, after measuring the improvement in an isolated copy, and rolls back otherwise. It is refused in CI.

| Input           | Type                        | Required | Meaning                                     |
| --------------- | --------------------------- | -------- | ------------------------------------------- |
| `planId`        | `IP-<hex>`                  | yes      | Plan id from `plan_improvement`             |
| `approvalToken` | 64 hexadecimal characters   | yes      | The token from the same plan                |
| `actor`         | string, 1 to 200 characters | no       | The person who approved the plan (recorded) |

- Returns: `attempt`, the recorded patch attempt.

## Run summary

`discover_specs`, `analyze_tests`, `run_mutation` and `verify_property` return a common summary:

| Field      | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `runId`    | Id of the new run                                                              |
| `verdict`  | `pass`, `pass_with_warnings`, `policy_failure`, `tool_error` or `inconclusive` |
| `exitCode` | The exit code the CLI would return                                             |
| `reasons`  | Why the verdict is what it is                                                  |
| `stages`   | Each stage with its `status` and `messages`                                    |
| `findings` | `id`, `kind`, `certainty`, `severity` and `title` of each finding              |

Results are returned both as `structuredContent` and as JSON text. Both are redacted (token patterns and secret environment values).

## Errors

A failing tool returns `isError: true` with a JSON body `{ "code", "category", "message", "hint" }`. `code` and `category` are those of the CLI (for example `NO_RUN` with category `user`); an unexpected exception has the code `UNEXPECTED` and the category `tool`. Inputs that do not match a tool's input schema are rejected before the tool runs.

## Approval tokens

Changing project files takes two steps:

1. `plan_improvement` stores the plan under `.veritas/improvements/<plan-id>/` and returns `approvalToken`, the SHA-256 of the plan's canonical content.
2. After a person has reviewed the plan (the `plan` field, or `plan.json` in that directory), the client passes the plan id and the token to `apply_approved_improvement`.

A token matches exactly one plan content. The apply is refused when the plan has changed, the plan id does not match, or a property used by the plan was rejected after planning. Without `--allow-write`, the tool does not exist. Each apply records `approval-<n>.json` with the approver, the time, the entry point (`mcp`) and the hash of the token. The approver comes from `actor`, then `VERITAS_ACTOR`, then the git `user.name`; the name is recorded as given and is not authenticated.

## Concurrency and progress

Long-running tools (those that run stages, `plan_improvement` and `apply_approved_improvement`) share a limit of `--max-concurrent` operations. Further calls wait for a free slot. `list_properties`, `get_evidence` and `get_run_status` only read files and are not limited.

When a call carries a `progressToken`, the server sends `notifications/progress` with one step per progress message and a total of the number of stages plus one. Messages are redacted.

## Cancellation

Cancelling a request (`notifications/cancelled`) aborts it. A call still waiting for a slot fails with `CANCELLED`; a running call stops its stages and the child processes they started, such as mutator, the project's tests or the solver process.
