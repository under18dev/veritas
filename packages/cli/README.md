# @under18dev/veritas

Specification-aware test verification for TypeScript/JavaScript projects tested with Vitest: what do the tests
actually guarantee against the documented specification, with evidence, counterexamples and an explicit scope.

```bash
npm install -D @under18dev/veritas
npx veritas init --yes
npx veritas run --profile quick
```

This package provides the `veritas` command, the `veritas-mcp` MCP server and the Node API
(`import { analyze } from '@under18dev/veritas'`). Documentation, the support matrix and the security model are
in the repository: https://github.com/under18dev/veritas

Licensed under Apache-2.0.
