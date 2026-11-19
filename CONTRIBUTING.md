# Contributing

## Setup

```bash
pnpm install
pnpm build
```

Node.js 24 or later and pnpm are required. Lean 4 (via [elan](https://github.com/leanprover/elan)) is needed for the Lean tests; CI installs it on every runner.

## Checks

```bash
pnpm lint              # Biome + dependency rules (no cycles, core depends on nothing else)
pnpm typecheck
pnpm test              # unit tests
pnpm test:acceptance   # end-to-end tests that run the CLI against copies of fixtures/
pnpm schemas           # regenerate schemas/ after changing a schema in packages/core
```

Run one package's tests with `pnpm exec vitest run --project unit packages/<name>`.

## Rules for changes

- Domain types live in `packages/core` as Zod schemas. Change them there, regenerate `schemas/`, and add a migration when an artifact format changes incompatibly (see ADR 0002).
- Never report `unknown`, `timeout`, `unsupported` or `semantic_mismatch` as success, and never return solver or mutation results that were not produced by the real tool.
- Specifications inferred from code are never accepted automatically; only approval records change review status.
- Write to the project only through `resolveInsideRoot`, run child processes only through `runCommand`, and redact anything that may contain secrets.
- Tests: no `.skip`, `.only` or `.todo` (lint enforces it). Fixtures in `fixtures/` encode ground truth in their `FIXTURE.md`; expected results are written from that table, never copied from tool output.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## Architecture decisions

Record design decisions as ADRs in `docs/adr/` before relying on them.
