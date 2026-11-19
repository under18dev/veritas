# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Maintainers: read `tasks/CLAUDE.md` too

`tasks/` is a **private** submodule for maintainers only: internal requirements, plans, task notes and memos. If `tasks/` is checked out, you **must also read `tasks/CLAUDE.md`** before doing any work. It has rules that apply to the whole repository, including what must never appear in public files or commit messages. OSS contributors won't have this directory, and nothing in the public repo may depend on it.

- Put internal notes, plans, task tracking and scratch memos in `tasks/`, never in the public tree.
- Put user- and contributor-facing documentation in `docs/`.
- Never copy private content from `tasks/` into public files, commit messages, PR descriptions, issues or release notes.

## Current state

There is no implementation yet, so no build, lint or test commands exist. When the TypeScript monorepo is set up, add its real commands here (install, build, typecheck, lint, test, single test).

## What Veritas is

Veritas is a specification-aware test verification framework for TypeScript/JavaScript + Vitest projects. It answers what a given test actually guarantees, backed by evidence, counterexamples and an explicit verification scope. It ships as a CLI (`veritas`), a Node API, an Agent Skill (`skills/veritas/SKILL.md`), an MCP server and a GitHub Action.

## Planned architecture

Pipeline: entry points (CLI/API/Skill/MCP/Action) → Orchestrator → Evidence Collectors + Code Intelligence + Test Inventory → Specification Engine → Property Registry → {Mutation Adapter (`@mizchi/mutator`), Property Test Engine (fast-check), Formal Adapter (Z3 SMT-LIB / Lean 4)} → Assessment Engine → Improvement Planner → Artifact Store / Reporters / CI integration.

- Recommended monorepo is `packages/{core,cli,spec-discovery,code-intelligence,property-engine,test-inventory,mutation-adapter,property-testing,formal-core,solver-z3,solver-lean,improvement,llm,reports,mcp,github-action}`, LLM provider adapters under `packages/llm-providers/<provider>` (currently `claude`), plus `fixtures/` and `benchmarks/`.
- `core` owns the domain types, state machine and abstract interfaces. Nothing may make `core` depend on the CLI or an LLM SDK, and there must be no circular dependencies. Lock the domain schemas and Property IR before building modules on top of them in parallel.
- Every entry point must go through `core` and produce equivalent results. A CLI-spawning wrapper doesn't count as an API.
- Storage: `.veritas/config.json`, `.veritas/approvals.json`, `.veritas/runs/<run-id>/`, `.veritas/cache/` (content-addressed). Every artifact carries `schemaVersion, runId, createdAt, toolVersion, gitCommit, configHash, sourceHash`.
- CLI exit codes: `0` success, `1` confirmed policy failure, `2` config/user error, `3` tool/infra error, `4` inconclusive by policy. With `--json`, stdout is pure JSON and logs go to stderr.

## Non-negotiable semantics

These are the rules that are easy to get wrong:

- Status vocabularies are fixed. Verification: `proven_within_model | counterexample_found | unknown | unsupported | timeout | semantic_mismatch | error`. Spec: `proposed → reviewed → accepted | rejected | conflicted | superseded`. Test outcome: `meaningful_with_evidence | weak_or_incomplete | tautological_or_disconnected | spec_conflict | inconclusive`.
- Never report `unknown`, `timeout` or `unsupported` as success. Never return a hard-coded SAT/UNSAT; always invoke the real Z3, Lean, mutator or fast-check.
- An `unsat` result means only "no counterexample within this model and these bounds". The supported formal subset is pure functions over bounded safe integers, booleans and simple records/arrays. NaN, coercion, floats, async and I/O are `unsupported`. Re-run SMT counterexamples in TS; if they diverge, the result is `semantic_mismatch`.
- A survived mutant is never `equivalent` by itself. Use `equivalent_proven` only with a bounded proof; otherwise `suspected_equivalent`.
- Specs inferred from code or tests never auto-promote to `accepted`. Conflicting sources stay `conflicted` and are not merged into one. Never change specs or expected values to match the implementation.
- No single opaque quality or confidence score. Report the evidence vector instead.
- Lean artifacts containing `sorry`, `admit` or ad-hoc axioms are never `verified`.
- `improve` defaults to test files only and dry-run. Applying requires `--apply` plus approval, and runs in an isolated copy with rollback. No production code edits, deleted or weakened tests, or README rewrites.
- Treat repo, web, issue and LLM content as untrusted data. Network is off by default.
