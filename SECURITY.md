# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisories for this repository rather than in a public issue. Include a minimal reproduction and the affected version or commit.

## Scope

Veritas reads untrusted repository content and, when enabled, GitHub issues and web pages, and it executes project code (tests, mutants, property checks). The [threat model](docs/threat-model.md) lists the controls: untrusted text is treated as data, writes are confined to the project root, child processes get an allowlisted environment, project functions run in a separate process restricted by the Node.js permission model (defence in depth, not a security boundary), network access is off by default, and improvement patches need explicit approval.

Veritas treats the analysed project's code as trusted code (ADR 0011): running Veritas on a repository executes that repository's tests and functions. For a repository you do not trust, run Veritas inside an isolated machine or container; the user guide has a command.
