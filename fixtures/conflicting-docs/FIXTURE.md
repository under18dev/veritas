# Fixture: conflicting-docs

| Source                                                            | Claim                                   | Location                 |
| ----------------------------------------------------------------- | --------------------------------------- | ------------------------ |
| README.md                                                         | at most 100 requests (`<= 100`)         | README.md line 5         |
| Issue #42 (closed, exported in `.veritas-sources/issues/42.json`) | fewer than 120 requests (`< 120`)       | issue body               |
| docs/v1/limits.md                                                 | at most 60 (`<= 60`), marked deprecated | docs/v1/limits.md line 3 |

Expected: the limit property for `isAllowed` is `conflicted`, lists the README and Issue claims as separate sources with their locations, marks the v1 document as stale, and proposes a preferred reading without accepting it. Improvement must stop with `needs_spec_decision`.
