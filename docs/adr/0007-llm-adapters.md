# ADR 0007: LLM adapters

## Context

LLMs help extract and propose specifications, but their output is never evidence or proof, and Veritas must work fully without one.

## Decision

- `@under18dev/veritas-llm` defines a provider-neutral interface with token budgets, input hashing, redaction and an option to never send full document text.
- Each provider adapter is its own package under `packages/llm-providers/<provider>/`, named `@under18dev/veritas-llm-<provider>`. The only adapter today is Claude (`packages/llm-providers/claude`, `@under18dev/veritas-llm-claude`, Anthropic SDK). Adding a provider means adding a directory there; `llm` and `core` do not change.
- The default provider is `none`. Without a provider or API key, the LLM capability is `disabled`/`unavailable` and rule-based analysis runs; nothing is fabricated.
- LLM output is stored with its input hash and marked as not reproducible.

## Consequences

Every feature has a rule-based path; LLM assistance only adds `inferred` candidates.
