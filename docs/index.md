---
layout: home

hero:
  name: Veritas
  text: What does your test actually guarantee?
  tagline: Specification-aware test verification for TypeScript and Vitest. It answers with mutants, counterexamples and proofs instead of a score.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is Veritas?
      link: /guide/what-is-veritas
    - theme: alt
      text: GitHub
      link: https://github.com/under18dev/veritas

features:
  - title: Specifications from your docs
    details: Reads README, docs, changelogs and code, and turns rules such as "1000 or more" into properties with the exact source line. Nothing becomes accepted without your review.
  - title: Mutants with meaning
    details: Runs real mutation testing and links every surviving mutant to the specification it violates, so a gap reads as "nobody checks total = 1000" rather than a percentage.
  - title: Counterexamples you can replay
    details: Checks properties with Z3 and fast-check, replays every counterexample in JavaScript, and reports semantic gaps between the model and the language instead of hiding them.
  - title: Proofs within stated bounds
    details: Bounded integer models in Z3 and kernel-checked Lean 4 proofs. Claims always carry their domain and assumptions; sorry, admit and extra axioms are never verified.
  - title: An evidence vector for each test
    details: Each test gets an evidence vector (specification relevance, assertions, kills, boundaries, formal claims, unknowns) and one of five outcomes. There is no score.
  - title: Built for CI and agents
    details: One engine behind the CLI, Node API, MCP server, Agent Skill and GitHub Action, with stable JSON, SARIF and exit codes. Offline by default.
---

<div class="vp-doc" style="max-width: 760px; margin: 64px auto 0; padding: 0 24px;">

## Thirty seconds

```bash
npm install -D @under18dev/veritas
npx veritas init --yes
npx veritas run --profile standard
```

On the small project from the [tutorial](/guide/tutorial), whose README says "1000 or more" while the code says `total > 1000`, the run reports:

```text
run run-20261120T105459627Z-000-0ed704  verdict: pass_with_warnings (exit 0)
[...]
succeeded   mutate
            mutator 0.4.5: succeeded
            counts: {"killed":16,"survived":1}
[...]
succeeded   assess
            assessments: {"weak_or_incomplete":2,"meaningful_with_evidence":2,"tautological_or_disconnected":1}; 3 finding(s)
[...]
findings (3):
  F-0b43c88cc3a6  [confirmed medium] no test detects total > 1000 -> total >= 1000 at src/pricing.ts:3
  F-89435b62ae1e  [suspected medium] src/pricing.ts#discountAmount may not satisfy "total >= 1000"
  F-99e71509e3c4  [suspected low] test "pricing works" does not check project behaviour
```

Veritas does not tell you that your tests are "87% good". It tells you which specification each test checks, which faults it would catch, what has been checked formally and within which bounds, and what is still unknown.

</div>
