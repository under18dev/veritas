# Reports and artifacts

The CLI, the Node API, the MCP server and the GitHub Action write the same files. This reference covers the report formats, the sections of a report, the files of a run directory under `.veritas/runs/<run-id>/`, the metadata the files carry, and how secrets are removed. For how to interpret a report, see [Reading results](/guide/reading-results).

## Report formats

```bash
veritas report                          # text summary of the latest run
veritas report --format html > report.html
veritas report --format sarif --run <run-id> > veritas.sarif
veritas report --json                   # same as --format json
```

| Format   | `--format` | File in the run directory | Use                                                   |
| -------- | ---------- | ------------------------- | ----------------------------------------------------- |
| Text     | `text`     | none (printed only)       | Terminal summary; the default of `veritas report`     |
| JSON     | `json`     | `report.json`             | Everything the other formats show, for tools          |
| Markdown | `markdown` | `report.md`               | Pull request comments and documents                   |
| HTML     | `html`     | `report.html`             | A single self-contained page for reading in a browser |
| SARIF    | `sarif`    | `report.sarif`            | SARIF 2.1.0 for code scanning tools, with locations   |

The files are written by commands that include the report stage (`veritas run` with any profile, and `veritas prove`), in the formats listed in `reports.formats` (default: `json`, `markdown`, `html`, `sarif`; `text` is never written to a file). `veritas report` renders any format on demand, from the latest run or from `--run <run-id>`, and redacts what it prints.

## Report sections

The JSON, Markdown and HTML reports have the same ten sections:

| Section                                       | Content                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1. Run metadata/environment/scope             | Run id, command, profile, options, stages with their status and messages, verdict and reasons, and the envelope metadata |
| 2. Collected evidence with provenance         | Sources (location, kind, trust) and the normative statements quoted from them                                            |
| 3. Property ledger                            | Every property with its review status, origin, sources and formal model                                                  |
| 4. Specification vs implementation mismatches | Findings where the code and a property disagree, with counterexamples                                                    |
| 5. Tests x properties matrix                  | Which test relates to which property                                                                                     |
| 6. Mutation outcomes                          | Mutants by status, and the tests that cover and kill them                                                                |
| 7. Formal claims                              | Each claim with its kind, status, engine, assurance, bounds, assumptions and counterexample                              |
| 8. Test assessments                           | The evidence vector and outcome of each test                                                                             |
| 9. Improvement proposals                      | Improvement plans made from the run, with their apply attempts                                                           |
| 10. Limitations                               | What the run could not check, and why                                                                                    |

The Markdown report summarizes the two sections that grow with the size of the project. "2. Collected evidence with provenance" gives the number of sources and statements of each source kind, with the three sources of each kind that have the most statements and two of their quotes. "3. Property ledger" lists every property that is not inferred, and shows the first five inferred properties in detail and counts the others. The JSON and HTML reports, and `evidence.json` and `properties.json` of the run, keep every entry. In every format, "10. Limitations" counts the inferred properties in one line instead of naming each one; the ledger marks each of them as inferred.

A section whose stage did not run is empty. An artifact that exists but cannot be read is an error, not an empty section, so a damaged file cannot hide its findings.

`report.json` carries `schemaVersion` and `meta` (the envelope metadata below) at the top level, followed by `run`, `sources`, `statements`, `properties`, `conflicts`, `tests`, `edges`, `assessments`, `mutants`, `claims`, `findings`, `improvements` and `artifactBase`.

## Run directory

A run of `veritas run --profile deep` produces this layout; other commands write the subset their stages produce.

```text
.veritas/runs/run-20261120T100639627Z-000-a465b9/
├── run.json              command, options, scope, stages, verdict, policy reasons
├── code-index.json       exported functions, signatures, branches (index stage)
├── evidence.json         sources and quoted statements (discover stage)
├── properties.json       properties, conflicts, statement mapping, formalization (spec stage)
├── test-map.json         tests, assertions, test-property edges (map stage)
├── mutation.json         mutants and their status (mutate stage)
├── mutation/             mutator's own report and the Vitest configuration it ran with
├── pbt.json              property-based test results with seeds (pbt stage)
├── pbt/                  one file per property-based test (PBT-<id>.json)
├── claims.json           formal claims (prove stage)
├── proofs/               solver inputs and outputs, JavaScript replays
├── assessments.json      test assessments (assess stage)
├── findings.json         findings
├── report.json  report.md  report.html  report.sarif
├── artifact-index.json   SHA-256 and metadata of every file without an envelope
└── trace.jsonl           every log event of the run, debug level included
```

The `mutation/` directory is absent when mutation results were reused from the cache.

| File                  | Content                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.json`            | Id, command, arguments, profile, scope, options, start and end time, each stage with its status, messages, artifacts and usage, the exit code, the verdict and the policy reasons                                                     |
| `code-index.json`     | The code index of the project's sources                                                                                                                                                                                               |
| `evidence.json`       | Collected sources with their provenance and trust, statements, and skipped sources                                                                                                                                                    |
| `properties.json`     | `properties`, `conflicts`, `mapping` (what became of each statement), `formalization` and `staleApprovals`                                                                                                                            |
| `test-map.json`       | The test inventory and the edges between tests, symbols and properties                                                                                                                                                                |
| `mutation.json`       | Mutation counts and mutants, each with the tests that cover it (`coveredBy`) and kill it (`killedBy`)                                                                                                                                 |
| `pbt.json`            | Each property-based test with status, seed, run count, counterexample, shrink path and replay command                                                                                                                                 |
| `claims.json`         | Formal claims: kind, status, engine and version, assurance, assumptions, scope, semantic gaps, solver input and output files, the counterexample and its JavaScript reproduction                                                      |
| `proofs/`             | For Z3: `<claim-id>.smt2` (the query), `<claim-id>.out` (the solver output) and `<claim-id>.replay.json` (the replay in JavaScript), plus range and bound checks for some claims. For Lean: `proofs/lean/<claim-id>/`, a Lake project |
| `assessments.json`    | One assessment per test: the evidence vector, the outcome and the unknowns                                                                                                                                                            |
| `findings.json`       | Findings with kind, title, severity, certainty, locations, and the properties and sources behind them                                                                                                                                 |
| `artifact-index.json` | Files that cannot carry an envelope, with path, kind, SHA-256, size and creation time                                                                                                                                                 |
| `trace.jsonl`         | One JSON object per log event (`time`, `level`, `message`, and fields such as `event` and `stage`), at most 4 MB; a final line says how many events were dropped                                                                      |

Veritas keeps the most recent `storage.retainRuns` finished runs (default 20) and deletes older ones when a run finishes. Runs still in progress are not deleted.

Other files under `.veritas/`:

| Path                               | Content                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `.veritas/config.json`             | Configuration (see [Configuration](/reference/configuration))                               |
| `.veritas/approvals.json`          | Append-only decisions on properties: who, when, what and why                                |
| `.veritas/improvements/<plan-id>/` | `plan.json`, and for each apply `approval-<n>.json` and `attempt-<n>.json`                  |
| `.veritas/generated-tests/`        | Files written by `veritas test generate`                                                    |
| `.veritas/cache/`                  | Signed, content-addressed cache of decisive solver results, LLM responses and mutation runs |

## Envelope metadata

The JSON files Veritas writes for a run (all except `report.json` and mutator's own files) are envelopes `{ "meta": { ... }, "data": ... }`:

```json
{
  "meta": {
    "schemaVersion": "1.0.0",
    "runId": "run-20261120T100618836Z-000-1951f4",
    "toolVersion": "0.1.2",
    "gitCommit": "8a0dfe77e920c63934c08149b2f0a7aa67aecaa0",
    "configHash": "26b755aea2820bc824e016aaa6c9c6a663f172075da0d22a449ae19ea1af9255",
    "sourceHash": "64bf135f24766bd2b631d31b80625951a3629b2c23f7d0b0deacc76437082b6b",
    "createdAt": "2026-11-20T10:06:20.072Z"
  },
  "data": []
}
```

| Field           | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| `schemaVersion` | Version of the artifact schemas                          |
| `runId`         | The run that wrote the artifact                          |
| `createdAt`     | When the artifact was written (ISO 8601, UTC)            |
| `toolVersion`   | Veritas version                                          |
| `gitCommit`     | `HEAD` of the analysed repository, or `null` without git |
| `configHash`    | Hash of the validated configuration                      |
| `sourceHash`    | Hash of the indexed source files                         |

Files that cannot hold an envelope (solver input and output, Lean sources, rendered reports, mutator's own report files) are listed in `artifact-index.json` with their SHA-256, and the index carries the metadata. The rendered reports show it too. `readArtifact` in the [Node API](/reference/api) validates a file against its schema and rejects it if it does not match.

## JSON Schemas

The JSON Schemas of the configuration and of the records in the artifacts are in [`schemas/`](https://github.com/under18dev/veritas/tree/main/schemas) in the repository:

| Schema                                        | Describes                                     |
| --------------------------------------------- | --------------------------------------------- |
| `config.json`                                 | `.veritas/config.json`                        |
| `artifact-meta.json`                          | The envelope metadata                         |
| `run.json`, `stage-result.json`               | A run and its stage results                   |
| `capability.json`                             | A capability reported by `veritas doctor`     |
| `evidence-source.json`                        | A collected source                            |
| `property.json`, `property-ir.json`           | A property and its formal model (Property IR) |
| `test-case.json`, `test-property-edge.json`   | A test and its relations to properties        |
| `mutant.json`                                 | A mutant                                      |
| `formal-claim.json`                           | A formal claim                                |
| `test-assessment.json`                        | A test assessment                             |
| `finding.json`                                | A finding                                     |
| `approval-ledger.json`                        | `.veritas/approvals.json`                     |
| `improvement-plan.json`, `patch-attempt.json` | An improvement plan and an apply attempt      |

The design is explained in [ADR 0002](/adr/0002-schemas-and-artifacts).

## Redaction

Secrets are removed before anything is written to an artifact, a report, a log or the trace, and again when `veritas report` prints, an MCP tool returns, or the GitHub Action writes its outputs and step summary. Redaction replaces with `[REDACTED]`:

- common token formats: Anthropic and OpenAI keys (`sk-ant-...`, `sk-...`), GitHub tokens (`ghp_...`, `github_pat_...` and the other `gh*_` prefixes), AWS access key ids, Slack tokens and PEM private keys;
- assignments such as `token=...`, `password: ...` and `api_key=...`, credentials in URLs (`https://user:pass@host`) and `Authorization` header values;
- the values of environment variables whose names contain `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `PRIVATE_KEY` or `CREDENTIAL` (values of at least 8 characters);
- the arguments of secret command-line flags such as `--token` or `--api-key` in recorded commands.

Logs and traces never include environment values or file contents. Prompts sent to an LLM are not stored (`storage.storePrompts` accepts only `false`).
