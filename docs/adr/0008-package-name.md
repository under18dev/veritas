# ADR 0008: npm package name

## Context

The unscoped name `veritas` is taken on npm, and the monorepo publishes several packages that need a scope the project owns.

## Decision

Packages are published under the `@under18dev` scope:

| Package directory | npm name                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `packages/cli`    | `@under18dev/veritas` (the `veritas` command)                                            |
| `packages/<name>` | `@under18dev/veritas-<name>`, e.g. `@under18dev/veritas-core`, `@under18dev/veritas-mcp` |

`packages/github-action` stays private; it is consumed as a GitHub Action, not from npm.

## Consequences

- Users install the CLI with `pnpm add -D @under18dev/veritas`. The command name stays `veritas`.
- Internal packages keep a common `veritas-` prefix, so they sort together and are recognisable in a lockfile.
- Publishing is a separate release step; until a version is on npm, documentation describes installing from the repository or packed tarballs.
