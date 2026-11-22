# Reading results

Veritas output contains a verdict, an exit code, findings, test outcomes and statuses. Here is how to read each of them; the exact definitions are in [Semantics](/concepts/semantics).

## Verdict and exit code

`veritas run` and `veritas prove` print both on their first line:

```text
run run-20261120T105508829Z-000-017911  verdict: policy_failure (exit 1)
```

| Verdict              | Exit code | Meaning                                                                     |
| -------------------- | --------- | --------------------------------------------------------------------------- |
| `pass`               | `0`       | Every stage succeeded, nothing is inconclusive and nothing needs review     |
| `pass_with_warnings` | `0`       | No policy failure, but there are findings to review or inconclusive results |
| `policy_failure`     | `1`       | A confirmed specification violation, or a configured threshold is not met   |
| `tool_error`         | `3`       | A stage failed                                                              |
| `inconclusive`       | `4`       | Something could not be decided and `policy.inconclusiveBehavior` is `fail`  |

Exit code `2` means a configuration or usage error, printed as `error[CODE]: message` followed by a `hint:` line, for example:

```text
error[APPROVAL_MISMATCH]: the approval token does not match plan IP-a14164357e16 (the plan changed or the token is wrong)
hint: review the plan again with `veritas improve --dry-run` and use the token it prints
```

Among findings, only confirmed ones fail the policy; a failed `maxNewSurvivors` or `minPropertyCoverage` threshold also does. Inconclusive results never produce `pass`: under the default `warn` policy the verdict is `pass_with_warnings` and each inconclusive item is listed. [CI and GitHub Action](/guide/ci#choose-what-fails-the-build) shows how to configure the policy.

With `--json`, stdout contains only the JSON result (`status`, `exitCode`, `runId`, `dir`, `reasons`, `stages`, `findings`) and logs go to stderr.

## Stages

Each block under the verdict is a stage and its status. Only `succeeded` is a success. `failed` and `error` are tool errors. `partial`, `skipped`, `unsupported`, `timeout` and `cancelled` are inconclusive.

## Findings

```text
F-89435b62ae1e  [confirmed high] src/pricing.ts#discountAmount does not satisfy "total >= 1000" for {"total":"1000"} (within the model)
```

Each finding has an ID, a certainty, a severity and a kind.

| Certainty       | Meaning                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`     | Shown by a real run (a mutation run, or a counterexample replayed in JavaScript); for a specification violation, the property is accepted       |
| `suspected`     | Needs your review, for example because the property is only proposed, or a conflict rests on an LLM-read, instruction-like or ambiguous reading |
| `informational` | Describes a limitation of the analysis                                                                                                          |

Severity is `critical`, `high`, `medium`, `low` or `info`.

| Kind                           | Typical cause                                               |
| ------------------------------ | ----------------------------------------------------------- |
| `spec_implementation_mismatch` | The code disagrees with a documented rule                   |
| `counterexample`               | A property-based test or the solver found a violating input |
| `spec_violation_candidate`     | A test built from the specification fails against the code  |
| `spec_conflict`                | Two sources state different rules                           |
| `survived_mutant`              | No test notices a change in code that a rule depends on     |
| `test_gap`                     | A boundary or behaviour is not checked                      |
| `tautological_test`            | A test does not check project behaviour                     |
| `unsupported_semantics`        | Code outside the supported formal subset                    |
| `stage_failure`                | A stage could not produce its result                        |

A confirmed finding of one of the first three kinds is a specification violation and, with the default `policy.confirmedViolation: fail`, sets exit code `1`.

## See the evidence for a finding

```bash
veritas explain <finding-id>
```

`explain` reads the latest run and prints the source and quoted line, the properties, the tests that call the code and their assessments, the mutants, the solver claims with their files, and the suggested next steps. The [tutorial](/guide/tutorial#_3-see-the-evidence-for-a-finding) shows a full example.

## Test outcomes

| Outcome                        | Meaning                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meaningful_with_evidence`     | The test asserts the result of a project function, kills specification-relevant mutants and asserts every decisive boundary input                                                                                                                                                                                                    |
| `weak_or_incomplete`           | The test checks something, but relevant mutants survive it or it misses a boundary                                                                                                                                                                                                                                                   |
| `tautological_or_disconnected` | The test does not check project behaviour (constant assertions, the target is never called)                                                                                                                                                                                                                                          |
| `spec_conflict`                | The test relates to a property whose sources conflict                                                                                                                                                                                                                                                                                |
| `inconclusive`                 | There is not enough evidence: the run has no mutation results, the code is reached through a dynamic import or a child process, the test checks only types (`expectTypeOf`, `assertType`, a type alias such as `Expect<Equal<A, B>>`), or it belongs to a shared or parameterized suite whose caller supplies the functions it calls |

The outcome summarizes the evidence vector below; it is not a grade.

### What counts as checking project code

A test checks project code when an assertion looks at what project code produced. For a plain function that is its return value, an object it changed, or how it called a callback or a `vi.fn()` mock the test handed to it.

Component and hook tests are read the same way. A project component counts as called once its JSX element is mounted: given to `render` (or `rerender`, `hydrate`), to a helper of the test code or the project that passes it on to one, returned by a component or factory whose result is, or kept in a local that is. An element given to a helper that only inspects it does not count, and an element given as a prop, or as children of a component whose code Veritas can read, counts only when that component's own code renders it. A project provider that wraps the component, such as `render(<Providers><Dialog /></Providers>)` with `Providers` returning `<section>{children}</section>`, therefore still counts: its children are mounted exactly when the `Providers` element is. Reading the element's own description (`ui.props.title`) is not reading what the component rendered. Testing Library imported as a namespace (`import * as rtl from '@testing-library/react'`) is read the same way as named imports. This holds whether the test writes `render(<Dialog />)` itself, renders in a `beforeEach` of an enclosing `describe` (not `beforeAll` or directly at module or `describe` level: Testing Library cleans the page up after each test, so `beforeEach` is the reliable form), calls a local helper such as `renderDialog()` that does, or renders a local wrapper component. For a local wrapper component, only what reaches the JSX it returns counts as rendered. Renderers that do not draw into the page run the component, but only their own output counts, not later reads of the page: server rendering (`renderToString`), react-test-renderer's `create`, Enzyme's `shallow` and `mount`, and `render` given a `container` that is not in the page. Enzyme's `shallow` runs only the root component; components nested in it are not run. An element that is only created, as in `expect(<Dialog />).toBeTruthy()`, does not count. A project hook called inside `renderHook` counts too. After that, these assertions count as checking the component or hook:

- a Testing Library query of the page (`screen.getByText`, `within(...)`, the queries returned by `render`), or a read of the global `document`, made after a project component rendered
- `result.current` from `renderHook`, and the output in what `render` returns (`container`, `baseElement`, or a query such as `getByText(...)` that is called); its API (`unmount`, `rerender`, `debug`, a query that is not called) does not count. Output methods of other renderers, such as Enzyme's `debug()`, `html()` and `text()`, count
- a component rendered through `createPortal` into the page, such as `document.body`, once the portal is mounted
- `toHaveBeenCalled*` or `.mock.calls` on a mock that was handed to the component or hook: directly as a prop or argument, inside a props object (`render(<Dialog {...props} />)` with `props.onSave` checked), or through a local helper or factory that passes or returns it

Some assertions still do not count:

- a mock that was never handed to project code, or a different member of a mock object than the one handed over (`onSave={mocks.onSave}` does not cover `mocks.track`)
- a value of a props object that the test set itself
- a prop that a later attribute or spread replaces (`<Dialog {...props} onSave={undefined} />` does not hand over `props.onSave`)
- a mock read before it was handed over, such as a call count saved or checked before the render
- the calls of a mock the test also calls itself, whether through a matcher such as `toHaveBeenCalled` or through `.mock.calls`
- a page read made before the component rendered (`const before = screen.queryByText('x')` before `render`), or a read of something the test wrote to the page itself (`document.body.className = 'dark'`), counting writes made by `beforeEach` setup that runs before the test, and only writes whose code runs: a write in a helper nothing calls, or in an event listener when the test fires no event, does not count. Once the test puts content into the page itself (`innerHTML`, `appendChild` and the like, also through a local such as `const body = document.body`), no later read of the page counts, because it may find that content. An element the test creates with `document.createElement` and appends without filling it only stops queries by role or by page structure, since a text query cannot find an empty element
- a `within(...)` query on a container that does not come from the rendered page, such as `document.createElement('div')`
- an element returned by a function that nothing runs, or rendered by a call inside such a function (a render helper the test calls runs, including one exported from a shared `test-utils` file)
- a project function given as an event handler to a DOM or third-party element (`<button onClick={handleClick}>`), or code in an inline handler there, when the test fires no event
- a page query when nothing from the project rendered, so a test that renders only third-party components is still reported

A page query also does not credit a project component whose children in the test hold no project component, such as `<Providers><Button>Go</Button></Providers>` or a provider helper that wraps whatever it is given: the query may find only what the test supplied. This also leaves out a component like `<Card>Body</Card>` when the query looks for something the card renders itself; such a test is reported unless another assertion links it.

### Tests whose project code could reach what they read

Some tests check a mock or the page that project code reaches without being handed it. Veritas does not count these as checking project code, because it only sees that the link is possible. It records the route instead (`reachedVia` on the call, suspicion `reachable_by_name`), and the test is `inconclusive` with a rationale such as "project code it calls can reach what it reads (mocked module src/api.ts); not shown to be what the assertion checks". This is not a `tautological_test` finding. A route is recorded when the assertion comes after the project call and the code reachable from that call (the called function, and the functions, components and values it names, followed into other project files) does one of these:

- uses an import from a module the test file replaces with `vi.mock`, when the mock checked is imported from that module, held by its mock factory (`vi.mock('./tabs', () => ({ useTabs: () => ({ remove: h.remove }) }))`), or held by the value configured for one of its mocks (`vi.mocked(load).mockResolvedValue(store)` with `store.set` checked) (route `mocked module …`)
- reads the global `document`, when the test reads the page through `document` (route `the page, through the global document`)
- accesses the member a spy on a global object or prototype watches (`vi.spyOn(Element.prototype, 'scrollIntoView')`), matched by its declaration, so `Math.log` is not `console.log` and a method of a project object is not a DOM method (route `spied …`)
- reads a global the test put the mock into (`window.monaco = { editor }`, `vi.stubGlobal('fetch', mock)`, or a helper that assigns its argument to a global); a method of the same name on a project object does not count (route `global …`)

No route is recorded when the test, or a helper of the test code it calls, uses the same module, global or member itself, or uses `document` (it may have written what is read), or when the mock is read before the project call. A mock put into a global, a spy, or a value configured for a mock must also be handed over before the project call by code that runs: in the test body before the call, or in module, describe-level or `beforeEach`/`beforeAll` code of a describe that encloses the test. A helper function of the test file that hands the mock over counts where it runs: at its earliest call before the project call (also through other helpers), or before the test when it is passed to `beforeEach` or `beforeAll` (`beforeEach(install)`) in such a describe. A hand-off after the call, in an `after` hook, in another test or in a helper nothing calls before the project call does not count; only a hoisted `vi.mock` (or `jest.mock`) applies wherever it is written. The route is found from names in the code, not from what runs: a read under a branch the test does not take still counts, which is one more reason the outcome stays `inconclusive`. Static analysis does not follow state a mocked module writes into an object the test imports (`captured.path` filled by a mocked component); such tests are still reported, so read them before acting on the finding.

### How mutation testing confirms a missing link

A missing link found by static analysis is an inference, so mutation results can overturn it. When a test that static analysis could not link to project code killed at least one mutant, it failed when project code changed, so it does observe project behaviour. It is then not reported as `tautological_test`; its outcome is `inconclusive`, and its rationale says how many mutants it killed. A kill shows that the test observes project behaviour, not which property it checks, so such a test is never `meaningful_with_evidence` or `weak_or_incomplete` until an assertion is linked to project code. This does not apply to a test that asserts nothing or only constants (`expect(true).toBe(true)`): such a test can only fail when the code it runs throws, so a kill does not show that it checks a result.

mutator normally stops running a mutant's tests at the first one that fails, so in one run a test may never get to run a mutant that another test killed first. The mutation stage therefore checks these tests in a second, narrow run after the main one. It runs only their test files, mutates only the project files each test calls into (or, for a test static analysis sees calling nothing, every project source its file imports), runs every test on every mutant (`--kill-matrix`), and runs at most one mutant per source line. It uses what is left of `mutation.timeoutMs` after the main run and follows `mutation.typecheck`. To leave it some time, the main run stops starting new mutants at 55% of `mutation.timeoutMs` instead of 75% when there are such tests to check and the rest of the timeout leaves the check at least a minute; the stage messages say when this was done. The check is not run when the main run already used `--kill-matrix`. Kills by the checked tests are merged into the main run's mutants, and a mutant the main run had not reached (`pending`) becomes `killed` when the check kills it. A survivor of the check changes no status, because only some of the tests ran it. The stage messages say how many tests were checked, how many killed a mutant, how many killed none and how many ran no mutant at all. `mutation.json` keeps the details under `confirmation`. Turn the check off with `mutation.confirmDisconnected: false`.

A test that is still reported after the check comes with one of these:

- "killed none of the N mutant(s) it runs": the test ran N mutants and none of them made it fail. This says only that those N changes did not affect what it checks. When N is small, or the check ran out of time before it reached the code the test is about, it is weak evidence: the test may well check code that no mutant it ran touched, such as a global or a spy the project code calls. It is stronger when N is large and the mutants sit in the code the test calls. Read the test before acting on it.
- "N other mutant(s) it covers were killed by another test first": the test covers these mutants, but it was not run on them, so whether it would detect them is not known.
- neither line: no mutant of this run ran against the test, for example because the check was skipped, ran out of time, or the code it reaches produced no mutant. The finding then rests on static analysis alone.

mutator names the tests that killed or covered a mutant by the full names the test runner gives them. For a table-driven test (`it.each`, `test.each`, Vitest's `test.for`, or a test inside `describe.each`) that is the title formatted for one row, such as `rejects 01.2.3.4`, while static analysis records the title as written (`rejects %s`). Such a name is matched to the title it was formatted from, with the placeholders the runners use (`%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O`, `%p`, `%#`, `%$`, and `$name`, `$name.path` or `$0` from objects and template tables), so every row's kills count for the one test that registers the rows. A kill is never credited to a test the runner may not have named, so a name that could belong to more than one test is credited to none of them, and the stage warnings list it with the reason:

- it fits the titles of two or more table-driven tests in its file (`rejects %s` and `rejects %s at %s` both fit `rejects a at b`);
- it is the exact title of one test, it also fits the title of a table-driven test, and the two may really have run under that name: mutator reports the name more than once, the exact test may not have run (it is skipped, a todo, registered under `if`, a loop, `skipIf` or `runIf`, or another test of its file has `.only`), or the template fits the name title by title (`it('case 1')` next to `it.each([[1]])('case %s')`). With Vitest, which joins titles with `>`, a placeholder stands for part of one title only, so `it.each(cases)('$name')` does not take `threshold > is free at 5000` from a plain test in `describe('threshold')`, and that test keeps its kills. Jest joins titles with a space, so there any fit counts;
- it fits a title, or mutator reports it more than once, in a file where static analysis could not read the full name of every test: a test title or `describe` title that is not a literal (``it(`fee for ${total}`)``, a title built in a loop), a test registered inside a function, or a call at the top level or in a `describe` callback that may register tests (a shared suite such as `runTests()`, imported or local, or a function passed to `describe`). Such a test may run under the same name, so names in that file are matched to no template; a name that one test has exactly is still credited to it, unless mutator reports the name more than once.

mutator numbers the second and later tests of a run that share a full name (`case 1#2`). Such a name is resolved through the name it shares, by the same rules. Some names stay unmatched although they come from a template, for example a Jest key with a character that cannot be part of an identifier other than `$` and `.` (`$a-b`), or a row value that prints nothing. Their kills are not credited to any test, rather than to a wrong one.

A file inside the analysis scope that imports Vitest's runtime (`expect`, `assert`, `vi`, or `import * as vitest from 'vitest'`) is treated as test code wherever it lives, because it only runs inside a test run. A mock utility such as `src/test-utils.ts` is therefore not counted as project code. The flip side is that a real function kept in such a file is not counted either, so a test that calls only that function is reported as not checking project behaviour. Move the function out of that file if it is project code.

## Evidence vector

Each assessment in `assessments.json` has these fields and no combined score:

| Field                    | Contents                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `specificationRelevance` | Properties the test relates to, with their review status                     |
| `assertionRelevance`     | `checks_result`, `weak`, `none` or `unknown`                                 |
| `mutationDetection`      | Mutants the test killed, mutants that survived it, others                    |
| `boundaryCoverage`       | Each relevant boundary and whether the test uses it (`yes`, `no`, `unknown`) |
| `formalEvidence`         | IDs of formal claims about the related properties                            |
| `sourceConfidence`       | Notes on the quality of the specification sources                            |
| `unknowns`               | What could not be determined                                                 |

`veritas report` prints the same information as a rationale line:

```text
T-97fef42e4cf7: weak_or_incomplete; rationale boundary not exercised: total >= 1000 (decisive inputs 999, 1000; asserted: none); formal evidence C-8aad536f8e71 counterexample_found (conformance, assurance none); unknowns no mutation results for this run; detection power not measured
```

## Verification statuses

| Status                 | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `proven_within_model`  | No counterexample exists within the stated model, domain bounds and assumptions         |
| `counterexample_found` | The solver found a violating input, and replaying it in JavaScript gave the same result |
| `semantic_mismatch`    | The solver's counterexample does not reproduce in JavaScript                            |
| `unknown`              | The solver gave no answer                                                               |
| `timeout`              | The solver hit `formal.maxSolverMs`                                                     |
| `unsupported`          | The code or property is outside the supported subset                                    |
| `error`                | The tool failed                                                                         |

`unknown`, `timeout`, `unsupported`, `semantic_mismatch` and `error` mean the question was not answered, so Veritas never counts them as success. They make the run inconclusive, and `policy.inconclusiveBehavior` decides whether that fails CI. [Verification](/guide/verification) explains each engine and the assurance levels `smt_bounded` and `kernel_checked`.

## Mutant statuses

| Status                                                     | Meaning                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `killed`                                                   | At least one test failed under the mutant                                                     |
| `survived`                                                 | Tests ran the mutant and none failed: a test gap candidate, not a bug and not equivalence     |
| `timeout`                                                  | The tests did not finish under the mutant; counted as detected but credited to no single test |
| `suspected_equivalent`                                     | No difference was observed; equivalence is not shown                                          |
| `equivalent_proven`                                        | No input in the stated bounded domain distinguishes it from the original                      |
| `compile_error`, `runtime_error`, `ignored`, `no_coverage` | Reported by the mutation backend                                                              |
| `pending`, `unknown`                                       | Not run, or not recognized; the mutation stage becomes `partial`                              |

A surviving mutant becomes `equivalent_proven` only through a bounded equivalence proof.

## Print a report

```bash
veritas report                          # text summary of the latest run
veritas report --format markdown
veritas report --format html > report.html
veritas report --format sarif > veritas.sarif
veritas report --format json
veritas report --run <run-id>           # a specific run
```

`veritas run` and `veritas prove` also write the report files listed in `reports.formats` (by default `report.json`, `report.md`, `report.html` and `report.sarif`) to the run directory; for runs of other commands, `veritas report` renders them on request. [Reports and artifacts](/reference/reports) describes the sections and files.
