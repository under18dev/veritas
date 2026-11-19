# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisories for this repository rather than in a public issue. Include a minimal reproduction and the affected version or commit.

## Scope

Veritas reads untrusted repository content and, when enabled, GitHub issues and web pages, and it executes project code (tests, mutants, property checks). The [threat model](docs/threat-model.md) lists the controls: untrusted text is treated as data, writes are confined to the project root, child processes get an allowlisted environment, project functions run in a Node.js permission-model sandbox, network access is off by default, and improvement patches need explicit approval.

Running Veritas on a repository you do not trust still executes that repository's tests. Use an isolated machine or container for untrusted code.
