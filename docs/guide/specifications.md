# Specifications

Veritas checks tests against specifications, and it takes those specifications from what the project already documents. It never decides on its own what the specification is: every property starts as `proposed`, and only a person can accept it.

## Where statements come from

`veritas discover` (and the `discover` stage of `veritas run`) collects evidence from these sources:

| Source          | What is read                                                                                  | Default |
| --------------- | --------------------------------------------------------------------------------------------- | ------- |
| README          | `README*` files                                                                               | On      |
| Documentation   | `docs/**/*.md`, `CHANGELOG*`, `RELEASE*`                                                      | On      |
| Code comments   | JSDoc on exported declarations in the files matched by `analysis.include`                     | On      |
| Schemas         | OpenAPI and JSON Schema bounds (`openapi.{json,yaml}`, `*.openapi.*`, `*.schema.*`)           | On      |
| Git history     | `git log`, one source per commit (the last 50)                                                | On      |
| Exported issues | JSON files under `.veritas-sources/issues/` and `.veritas-sources/pulls/`                     | On      |
| GitHub API      | Issues and pull requests of `sources.github.repo`                                             | Off     |
| Web             | Pages on the domains in `sources.web.allowDomains`, within page, depth, size and time budgets | Off     |

Network sources need both the configuration and a run without `--offline`. For the web, `sources.web.enabled` must be `true` and the domain must be allowed:

```bash
veritas discover --sources local,web --allow-domain docs.example.com --max-pages 10
```

`--allow-domain` and `--max-pages` only add to or tighten the configuration for one run; they do not enable web discovery by themselves. The GitHub source sends `GITHUB_TOKEN` when it is set.

Collected text is stored as untrusted data. Instructions inside a README, an issue or a web page are never followed; they are only quoted.

## From statements to properties

Statements are extracted with rules for English and Japanese threshold phrases ("1000 or more", "1000 以上", "at most", "less than" and so on). An optional LLM can read statements the rules cannot; see [LLM providers](/guide/llm-providers). A statement becomes a property when it can be tied to one exported function and one parameter:

```text
quote   line 7: "Orders with a total of 1000 or more receive a flat discount of 100."
property P-ee03e6e8b749 [proposed, normative] discountAmount: total >= 1000 -> Orders with a total of 1000 or more receive a flat discount of 100.
```

Every property keeps its provenance: the source, the file and line (`README.md:7`), the quoted text, and the assumptions made when formalizing it. `veritas spec show <id>` prints them, together with the formal model. A statement that matches no function clearly stays unmapped and is reported as such; Veritas does not guess.

Properties have an origin:

| Origin      | Comes from                                                   |
| ----------- | ------------------------------------------------------------ |
| `normative` | Documentation, schemas, issues                               |
| `inferred`  | The code or the tests (for example, a comparison in an `if`) |
| `observed`  | Runtime observation                                          |
| `human`     | A person                                                     |

Inferred and observed properties are hypotheses about what to check. They are never independent evidence for themselves: a property inferred from `total > 1000` cannot confirm that `total > 1000` is right. Set `analysis.inferSpecsFromCode` to `false` to turn them off.

## Property lifecycle

```text
proposed -> reviewed -> accepted
                     -> rejected
                     -> conflicted
                     -> superseded
```

| Status       | Meaning                                                   |
| ------------ | --------------------------------------------------------- |
| `proposed`   | Found by Veritas, not decided. Every property starts here |
| `reviewed`   | Looked at, not yet decided                                |
| `accepted`   | A person accepted it as the specification                 |
| `rejected`   | A person rejected it                                      |
| `conflicted` | Sources disagree; a person has to choose                  |
| `superseded` | Replaced by a newer property                              |

Only accepted properties count as the specification:

- `veritas prove` checks accepted properties; `--include-proposed` adds the others, and their results stay `suspected` and experimental.
- A specification violation can be `confirmed` only against an accepted property.
- `veritas improve` takes expected values only from accepted properties, unless you pass `--include-proposed`.

## Conflicts are never merged

When two sources state different rules for the same thing, for example the README says "1000 or more" and a later issue says "more than 1000", both properties become `conflicted`. Veritas shows both sources and may suggest a preferred reading, but it does not pick one and does not merge them. Tests related to a conflicted property are assessed `spec_conflict`. Resolve the conflict by accepting one property and rejecting the other.

Veritas also never edits README, docs or issues, and never changes a specification or an expected value to match the implementation.

## Reviewing with the CLI

```bash
veritas spec list                      # properties of the latest run, with status and origin
veritas spec show <property-id>        # one property: sources, assumptions, formal model, approvals
veritas spec accept <property-id> --reason "README is the source of truth" [--actor <name>]
veritas spec reject <property-id> --reason "outdated" [--actor <name>]
veritas spec diff                      # properties added and removed between the last two runs
veritas spec export                    # the registry as JSON
```

`--reason` is required. The actor defaults to `VERITAS_ACTOR`, then the git user name. The actor name is recorded as given; it is not authenticated.

## The approvals file

Decisions are appended to `.veritas/approvals.json`:

```json
{
  "schemaVersion": "1.0.0",
  "approvals": [
    {
      "id": "A-aeaeacd1d243",
      "propertyId": "P-ee03e6e8b749",
      "propertyVersion": 1,
      "decision": "accept",
      "actor": "you",
      "reason": "README is the pricing specification",
      "decidedAt": "2026-11-20T10:46:53.311Z",
      "sourceIds": ["src-fa35c6154f0b"]
    }
  ]
}
```

The file is append-only: a later decision is added, earlier ones are kept. A decision applies to the property version it was made for. When the content of a property changes, it has to be reviewed again.

Keep the approvals file with the project so that the whole team works from the same decisions, and see [Getting started](/guide/getting-started#where-the-results-go) for a `.gitignore` that keeps it.

Approvals cannot be changed through the MCP server. Agents following the Agent Skill only run `spec accept` or `spec reject` when you tell them which property and why.
