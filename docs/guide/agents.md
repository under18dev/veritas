# Agents and MCP

Coding agents can use Veritas in two ways: through the Agent Skill, which teaches an agent to drive the `veritas` CLI, and through the MCP server `veritas-mcp`, which exposes Veritas as tools. Both run the same engine as the CLI.

## Agent Skill

The skill is a single file, `skills/veritas/SKILL.md`, in the Veritas repository. It tells an agent when to use Veritas, which commands to run, how to read the results, and where to stop and ask you. It works with any agent that loads Agent Skills.

### Install

The skill is not part of the npm package. Copy it from the repository into the place your agent loads skills from. For Claude Code, that is `.claude/skills/` in the project, or `~/.claude/skills/` for all projects:

```bash
mkdir -p .claude/skills/veritas
curl -fsSL https://raw.githubusercontent.com/under18dev/veritas/main/skills/veritas/SKILL.md \
  -o .claude/skills/veritas/SKILL.md
```

The skill expects `@under18dev/veritas` to be installed in the project (`npm install -D @under18dev/veritas`). If it is not, the agent asks you how to install it instead of installing anything on its own.

### What the skill makes the agent do

- Ask before running anything that executes project code (`run --profile standard|deep`, `mutate`, `prove`, `improve`), and suggest a container for repositories you do not trust.
- Run `init`, `doctor`, `run --profile deep --offline --include-proposed --json`, then `report`, `explain` and `spec list`.
- Report `proven_within_model` together with its domain, and never present `unknown`, `timeout`, `unsupported` or `semantic_mismatch` as success.
- Never run `spec accept` or `spec reject` unless you say which property and why, and stop on `conflicted` properties.
- Plan improvements with `improve --dry-run`, and apply only the exact plan and token you approved.
- Never enable network sources, edit README or docs, change expected values, or use `--allow-code-config` unless you ask.

Ask the agent things like "Are these tests meaningful?", "Does the code follow the discount rule in the README?" or "Which boundaries are untested?".

## MCP server

The package installs a second command, `veritas-mcp`, which serves Veritas over MCP on stdio:

```text
Usage: veritas-mcp [--root <dir>] [--max-concurrent <n>] [--allow-write]

Serves Veritas over MCP (stdio).
  --root <dir>          project root (default: current directory)
  --max-concurrent <n>  analysis jobs allowed at once (default: 1)
  --allow-write         register the tool that applies approved improvement plans
```

### Register it in Claude Code

With the package installed in the project:

```bash
claude mcp add veritas -- npx veritas-mcp --root /path/to/project
```

Without installing it first:

```bash
claude mcp add veritas -- npx -y -p @under18dev/veritas veritas-mcp --root /path/to/project
```

The `-p` matters: the package has two commands, and `npx @under18dev/veritas` without `-p` runs `veritas`, not `veritas-mcp`.

### Register it in other MCP clients

Most clients take a JSON entry with a command and arguments:

```json
{
  "mcpServers": {
    "veritas": {
      "command": "npx",
      "args": ["-y", "-p", "@under18dev/veritas", "veritas-mcp", "--root", "/path/to/project"]
    }
  }
}
```

Each client session starts its own server process. Every tool call writes a new run directory under `.veritas/runs/`. At most `--max-concurrent` long operations run at once; others wait or are cancelled.

### Tools

| Tool                         | What it does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| `discover_specs`             | Collects specification evidence, offline                                 |
| `list_properties`            | Lists properties of the latest run with status, origin and sources       |
| `analyze_tests`              | Indexes code and tests and assesses each test (no mutation run)          |
| `run_mutation`               | Runs mutation testing and relates mutants to properties and tests        |
| `verify_property`            | Checks formalized properties with Z3 and replays counterexamples         |
| `get_evidence`               | Returns the evidence chain of a finding                                  |
| `get_run_status`             | Returns the status, stages, verdict and usage of a run                   |
| `plan_improvement`           | Plans test-only improvements and returns the plan and its approval token |
| `apply_approved_improvement` | Applies a reviewed plan. Only with `--allow-write`                       |

The [MCP reference](/reference/mcp) documents the inputs and outputs of each tool.

### Writes and approvals

Without `--allow-write`, the server cannot change project files: the tools write only under `.veritas/`. Approvals of specifications cannot be changed through MCP at all; use `veritas spec accept|reject` yourself.

With `--allow-write`, `apply_approved_improvement` is registered. It needs the exact plan ID and the 64-character approval token from `plan_improvement`, and records the approver. Give the agent the token only after you have reviewed the plan. Applying runs in a fresh temporary copy, which is deleted afterwards, adds only new test files, rolls back if the results do not improve, and is refused in CI. See [Improving tests](/guide/improving-tests).

::: warning
The MCP server runs the project's tests and functions, with the same trust as `pnpm test`. Do not point it at a repository you do not trust; see [Untrusted repositories](/guide/untrusted-repositories).
:::
