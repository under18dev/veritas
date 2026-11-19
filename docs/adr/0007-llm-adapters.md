# ADR 0007: LLM adapters

## Context

LLMs help extract and propose specifications, but their output is never evidence or proof, and Veritas must work fully without one.

## Decision

- `@under18dev/veritas-llm` defines a provider-neutral interface with token budgets, input hashing, redaction and an option to never send full document text.
- The only bundled adapter is Claude (`@under18dev/veritas-llm-claude`, Anthropic SDK). Other providers are added as separate adapter packages.
- The default provider is `none`. Without a provider or API key, the LLM capability is `disabled`/`unavailable` and rule-based analysis runs; nothing is fabricated.
- LLM output is stored with its input hash and marked as not reproducible.

## Consequences

Every feature has a rule-based path; LLM assistance only adds `inferred` candidates.
