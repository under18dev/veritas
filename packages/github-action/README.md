# @under18dev/veritas-github-action

The program behind the Veritas GitHub Action

Part of [Veritas](https://github.com/under18dev/veritas), specification-aware test verification for TypeScript/JavaScript projects. Use the action in a workflow rather than this package directly:

```yaml
- uses: under18dev/veritas/packages/github-action@v0.2.0
  with:
    profile: standard
```

The action runs this package's `veritas-github-action` command with the job's Node.js. See the [GitHub Action reference](https://veritas.under18.dev/reference/github-action). Source: [`packages/github-action`](https://github.com/under18dev/veritas/tree/main/packages/github-action).

Licensed under Apache-2.0.
