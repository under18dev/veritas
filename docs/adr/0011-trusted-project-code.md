# ADR 0011: Project code is trusted code

## Context

Veritas executes the code of the project it analyses. Property-based tests and counterexample replay call project functions, and mutation testing and `improve` run the project's own Vitest suite. Property-based tests and replay run in a separate Node.js process under the permission model: the process can read the project only, cannot write files or start child processes, workers or generated code, and on Node.js 25+ it has no network access.

The Node.js permission model protects against accidents; it is not a security boundary against hostile code. Node.js documents it that way, and native addons, inherited file descriptors and runtime bugs are known ways around it. Real isolation means an operating-system mechanism such as a container, a VM, namespaces with seccomp on Linux, or `sandbox-exec` on macOS. None of these is available in the same form on Windows, macOS and Linux without extra software, so no portable implementation exists.

## Decision

- Veritas runs project code with the same trust as the project's own test suite (`pnpm test`). The restrictions above remain as defence in depth and are not described as a sandbox for untrusted code.
- To analyse a repository you do not trust, run Veritas itself inside an isolated environment, for example a container without network access. The user guide gives a command.
- Everything else is unchanged:
  - repository, web, issue and LLM content is untrusted data;
  - writes need approval and stay inside the project;
  - network is off by default;
  - child processes get an allowlisted environment;
  - fork pull requests run without secrets.

## Consequences

- The threat model, security policy, support matrix and Agent Skill state the trust level and point to the container procedure.
- Built-in OS-level isolation can be revisited when it can be offered on all three platforms. It would require a new ADR.
