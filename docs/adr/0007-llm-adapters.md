# ADR 0007: LLM adapters

## Context

LLMs help extract and propose specifications, but their output is never evidence or proof, and Veritas must work fully without one.

## Decision

- `@under18dev/veritas-llm` defines a provider-neutral interface with token budgets, input hashing, redaction and an option to never send full document text.
- Each provider adapter is its own package under `packages/llm-providers/<provider>/`, named `@under18dev/veritas-llm-<provider>`. Adding a provider means adding a directory there; `llm` and `core` do not change.
- Adapters: `claude` (Anthropic API), `openai` (OpenAI Responses API), and two that run a vendor CLI with the user's own login: `claude-code` (`claude -p`) and `codex` (`codex exec`). Veritas never reads or stores CLI credentials and does not pass API keys to the CLIs. The CLIs run without tools, MCP servers, settings or sessions, in an empty temporary directory.
- The default provider is `none`. Without a provider or API key, the LLM capability is `disabled`/`unavailable` and rule-based analysis runs; nothing is fabricated.
- LLM output is stored with its input hash and marked as not reproducible.

## Consequences

Every feature has a rule-based path; LLM assistance only adds `inferred` candidates.
