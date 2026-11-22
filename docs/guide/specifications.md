# Specifications

Veritas never decides on its own what your specification is. It creates each property as `proposed`, or `conflicted` when sources disagree, and only you can accept one. Read on for where Veritas finds the rules it checks against, how a rule becomes a property, and how you accept, reject and track properties.

## Where rules come from

`veritas discover`, and the `discover` stage of `veritas run`, read these sources:

| Source          | What is read                                                                                 | Default |
| --------------- | -------------------------------------------------------------------------------------------- | ------- |
| README          | `README*` files                                                                              | On      |
| Documentation   | `docs/**/*.md`, and `CHANGELOG*` and `RELEASE*` files in Markdown or plain text              | On      |
| Code comments   | JSDoc on exported declarations in files matched by `analysis.include`                        | On      |
| Schemas         | Bounds in OpenAPI and JSON Schema files (`openapi.{json,yaml}`, `*.openapi.*`, `*.schema.*`) | On      |
| Git history     | Commit messages                                                                              | On      |
| Exported issues | JSON files under `.veritas-sources/issues/` and `.veritas-sources/pulls/`                    | On      |
| GitHub API      | Issues and pull requests of `sources.github.repo`                                            | Off     |
| Web             | Pages on the domains in `sources.web.allowDomains`, within page, depth, size and time limits | Off     |

To use a network source, enable it in `.veritas/config.json` and run without `--offline`. For the web, also allow the domain:

```bash
veritas discover --sources local,web --allow-domain docs.example.com --max-pages 10
```

`--allow-domain` and `--max-pages` apply to one run and do not enable web discovery by themselves. The GitHub source sends `GITHUB_TOKEN` when it is set.

A URL on a domain that is not allowed is skipped with a reason that names the domain and how to allow it. This includes `github.com` links to the repository in `sources.github.repo`: enabling the GitHub source lets Veritas read that repository's issues and pull requests through the GitHub API, not crawl its pages on github.com, which are mostly diffs and file views. To fetch those pages too, add `github.com` to `sources.web.allowDomains`.

The web crawl reads only text documents: HTML, plain text and Markdown. A response of another type, such as a stylesheet, a script, an image or a font, is skipped with the reason `not a text document (<type>)` and its body is not read. A response that does not state its Content-Type is read as text. When it follows links, the crawl takes only `<a href>` links and leaves out links to stylesheets, scripts and their source maps, images and fonts, by their extension. A URL written in the project itself is fetched whatever its extension, when its domain is allowed, and judged by its Content-Type.

Text from these sources is stored as untrusted data. Instructions written inside a README, an issue or a web page are quoted, never followed.

You can also state a rule yourself, as a function that returns `true` when the rule holds, and declare it under `properties` in `.veritas/config.json`. A declared property gets the ID `D-<id>` and goes through the same review as the others: it is `proposed` until you accept it. See [Declare a property](/guide/verification#declare-a-property).

## How a rule becomes a property

Veritas reads threshold phrases in English and Japanese, such as "1000 or more", "at most", "less than", "1000 以上" and "未満". When a statement matches one exported function and one parameter, it becomes a property:

```text
quote   line 7: "Orders with a total of 1000 or more receive a flat discount of 100."
property P-ee03e6e8b749 [proposed, normative] discountAmount: total >= 1000 -> Orders with a total of 1000 or more receive a flat discount of 100.
```

A numeric threshold is bound only to a parameter or record field declared as a number. A field such as `lastUsedDay: string | null` is skipped even when its name matches the wording. Numeric enums, branded numbers such as `number & { __brand: "cents" }` and literal unions such as `1 | 2 | 3` count as numbers, and a field whose type Veritas cannot resolve is kept as a candidate. A field the function compares outranks one it never compares. The statement stays unmapped only when the quantity it names is an uncompared number field of the same record and the compared field matches neither that quantity nor the words right after the value. When other parameters also match the statement, the property lists them in its assumptions so you can check the binding before accepting it.

A statement that matches no single function stays unmapped and is reported as such, together with the candidates that tied. An optional [LLM provider](/guide/llm-providers) can read statements that the phrase rules do not cover.

Each property records its source file and line, the quoted text, and the assumptions made to formalize it. Its origin tells you where it came from:

| Origin      | Comes from                                              |
| ----------- | ------------------------------------------------------- |
| `normative` | Documentation, schemas, issues                          |
| `inferred`  | Your code or tests, for example a comparison in an `if` |
| `observed`  | Runtime observation                                     |
| `human`     | A person                                                |

`inferred` and `observed` properties suggest what to check. They never count as evidence for themselves: a property inferred from `total > 1000` cannot show that `total > 1000` is right. Set `analysis.inferSpecsFromCode` to `false` to stop inferring properties from code.

## Review the properties

```bash
veritas spec list                 # properties of the latest run, with status and origin
veritas spec show <property-id>   # sources, assumptions, formal model and decisions for one property
veritas spec diff                 # properties added and removed between the last two runs
veritas spec export               # all properties as JSON
```

| Status       | Meaning                                    |
| ------------ | ------------------------------------------ |
| `proposed`   | Found by Veritas and not decided           |
| `reviewed`   | Looked at, not decided                     |
| `accepted`   | Accepted as the specification              |
| `rejected`   | Rejected                                   |
| `conflicted` | Its sources disagree with another property |
| `superseded` | Replaced by a newer property               |

Only accepted properties act as the specification:

- `veritas prove` checks accepted properties. With `--include-proposed` it checks the others as well, and their results stay `suspected`.
- A specification violation is `confirmed` only against an accepted property.
- `veritas improve` takes expected values only from accepted properties, unless you pass `--include-proposed`.

## Accept or reject a property

```bash
veritas spec accept <property-id> --reason "README is the source of truth"
veritas spec reject <property-id> --reason "outdated"
```

| Option            | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `--reason <text>` | Why you decided (required)                                                            |
| `--actor <name>`  | Who decided. Default: `VERITAS_ACTOR`, then `git config user.name`. Recorded as given |

## Resolve a conflict

When two sources state different rules for the same function and parameter, for example the README says "1000 or more" and an issue says "more than 1000", both properties become `conflicted` and the tests related to them are assessed `spec_conflict`. Veritas shows both sources and, unless they rank equally, names a preferred reading (a statement from a newer release ranks higher, for example). It does not merge the properties or accept one for you. Accept the property that is right and reject the other.

The `spec_conflict` finding is `confirmed` only when every reading in it was extracted by the phrase rules and bound to the parameter without another plausible candidate. If one reading is a threshold an LLM read from free text, comes from text containing instruction-like content, or has an ambiguous binding, the finding is `suspected`, and its explanation says which reading is the doubtful one.

Veritas never edits your README, docs or issues, and never changes a specification or an expected value to match the code.

## The approvals file

Decisions are appended to `.veritas/approvals.json`; earlier entries are kept.

```json
{
  "schemaVersion": "1.0.0",
  "approvals": [
    {
      "id": "A-7d000af7e5fa",
      "propertyId": "P-ee03e6e8b749",
      "propertyVersion": 1,
      "decision": "accept",
      "actor": "you",
      "reason": "README is the pricing specification",
      "decidedAt": "2026-11-20T10:55:08.580Z",
      "sourceIds": ["src-fa35c6154f0b"]
    }
  ]
}
```

Commit this file so that everyone, including CI, works from the same decisions. [Getting started](/guide/getting-started#find-the-results) shows a matching `.gitignore`.

## When a property needs review again

A decision applies to one property ID. The ID is derived from the content of the source file and the statement, so it stays the same across commits while that file is unchanged. When you edit the file that contains a statement, its properties get new IDs and appear as `proposed`. Run `veritas spec diff` to see the old and new IDs, and accept or reject the new ones.

A declared property keeps its ID (`D-<id>`) when you edit it. Its version changes instead, with its description, target, kind or domain, so the earlier decision no longer applies and the property is `proposed` again until you decide on it again.

Approvals cannot be changed through the MCP server.
