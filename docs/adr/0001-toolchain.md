# ADR 0001: Monorepo and toolchain

## Context

Veritas is a set of cooperating modules (core, CLI, collectors, engines, adapters, reports, MCP, Action) that must not form dependency cycles and must be usable separately through a Node API.

## Decision

- pnpm workspace with one package per module under `packages/`.
- TypeScript 6.0.x, strict, ESM, project references (`tsc -b`). TypeScript 7 is the native port and does not ship the JavaScript Compiler API that code intelligence needs (ADR 0003), so the whole repository stays on 6.0.x until that API is available.
- Node.js 24 or later, matching `@mizchi/mutator`'s requirement.
- Vitest for our own tests: `unit` project (`packages/*/test`) and `acceptance` project (`test/acceptance`, runs the built CLI against copies of `fixtures/`).
- Biome for lint and format. `noFocusedTests` and `noSkippedTests` are errors.
- dependency-cruiser forbids cycles and any dependency from `@under18dev/veritas-core` on other workspace packages, CLI frameworks or LLM SDKs.

## Consequences

Acceptance tests need `pnpm build` first (`pnpm test:acceptance` does it). Upgrading TypeScript requires revisiting this ADR.
