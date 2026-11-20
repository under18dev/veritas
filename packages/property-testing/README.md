# @under18dev/veritas-property-testing

Property-based testing (fast-check) for Veritas properties, run in a separate process restricted by the Node.js permission model (defence in depth; the project's code is trusted code)

Part of [Veritas](https://github.com/under18dev/veritas), specification-aware test verification for TypeScript/JavaScript projects. Most users install the main package, which provides the `veritas` and `veritas-mcp` commands and the Node API:

```bash
npm install -D @under18dev/veritas
```

This package is an internal building block of that package; its API may change between minor versions. Source: [`packages/property-testing`](https://github.com/under18dev/veritas/tree/main/packages/property-testing).

Licensed under Apache-2.0.
