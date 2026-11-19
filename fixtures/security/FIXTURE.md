# Fixture: security

- `docs/injected.md` contains instructions aimed at an agent. Veritas must store it as untrusted data, may extract the factual statement ("at least 0") as a normative candidate, and must not change any property status, policy, file or network behaviour because of it.
- Secret redaction, path traversal and symlink tests create their inputs at test time (secrets are never committed, and committed symlinks are not portable). `test/acceptance/security-fixture.test.ts` adds, next to a copy of this fixture, a directory outside the project with a source file, a document, a test file and a `tsconfig.json`, then:
  - links `src/linked`, `docs/external` and `config` (directory junctions) to it: Veritas must not index, quote or parse anything behind them, and a `project.tsconfig` reached through `config` is ignored as outside the root;
  - points `analyze`, `replay`, `report --run` and `explain` at paths or ids with `../`: each is rejected;
  - points `analysis.include`, `analysis.testInclude` and `project.tsconfig` at `../` paths: nothing outside is read;
  - in every case nothing is written outside the project, including the `../../outside.txt` the injected document asks for.
