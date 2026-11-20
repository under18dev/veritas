# Untrusted repositories

Veritas runs the code of the project it analyses. Treat running Veritas on a repository the same as running that repository's test suite.

## The trust model

Project code is trusted code ([ADR 0011](/adr/0011-trusted-project-code)). These steps execute it:

| Step                               | What runs                                        |
| ---------------------------------- | ------------------------------------------------ |
| `run --profile standard`, `mutate` | The project's own Vitest suite, once per mutant  |
| `run --profile deep`               | Also project functions, for property-based tests |
| `prove`                            | Project functions, to replay counterexamples     |
| `improve --apply`                  | The project's tests, in an isolated copy         |
| Running files from `test generate` | The project's code, through Vitest               |

`run --profile quick`, `discover`, `analyze`, `spec`, `report` and `explain` do not execute project code.

Property-based tests and counterexample replay run in a separate Node.js process under the Node.js permission model: it can read the project only, cannot write files or start child processes, workers or generated code, and on Node.js 25 or later has no network access. Mutation testing and `improve` run the project's own test runner with an allowlisted environment and an empty temporary home directory, but without file-read or network isolation.

These restrictions protect against accidents. They are not a security boundary against hostile code: the Node.js permission model is documented as such, and native addons, inherited file descriptors and runtime bugs are known ways around it.

What does not change with the trust level:

- Repository, web, issue and LLM content is untrusted data. Instructions inside it are never followed.
- Writes need approval and stay inside the project.
- Network is off by default. `--offline` stops Veritas itself from making requests, but not the project's tests.
- Child processes get an allowlisted environment.
- In CI, fork pull requests run without secrets.

## Analysing a repository you do not trust

Run Veritas itself inside an isolated environment, on a copy of the repository, with no network. Docker works on Linux, and through Docker Desktop on macOS and Windows:

```bash
# An image with Veritas, built without any project code.
printf 'FROM node:26\nRUN npm install -g @under18dev/veritas\n' | docker build -t veritas -
# Work on a fresh copy, so nothing the project's code does can change your checkout.
copy=$(mktemp -d) && cp -R untrusted-repo/. "$copy" && cd "$copy"
# Install the dependencies from the lockfile without running install scripts. Use the project's package
# manager: `pnpm install --frozen-lockfile --ignore-scripts`, `yarn install --immutable --mode=skip-build`
# (Yarn 2+) or `bun install --frozen-lockfile --ignore-scripts` instead of npm (enable them with corepack).
docker run --rm -v "$PWD":/work -w /work veritas npm ci --ignore-scripts
# Analyse with no network at all.
docker run --rm --network none -v "$PWD":/work -w /work veritas veritas init --yes
docker run --rm --network none -v "$PWD":/work -w /work veritas veritas run --offline --profile deep
```

Notes:

- The dependency install is the only step with network access, and it runs no install scripts.
- The analysis runs with `--network none`, so neither Veritas nor the project's tests can reach the network.
- Lean is not part of this image; add elan to it if you use `prove --engine lean`.
- Read the results from the copy (`$copy/.veritas/runs/`), or run `veritas report` and `veritas explain` in the same container.

::: warning Cache key
The result cache is signed with a key in your cache directory (`~/.cache/veritas/cache-key`, or `VERITAS_CACHE_KEY_FILE`). The project's tests could read that key when they run outside a container. For code you do not trust, run in a container as above, or set `cache.enabled` to `false`.
:::

See the [security model](/concepts/security) for the full threat model.
