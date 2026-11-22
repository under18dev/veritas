/**
 * Differential test of the test outcome kernel against the implementation of assessTest it replaced. The previous
 * implementation is frozen here as the oracle, to show that moving the decision into decision.ts changed nothing
 * but the deliberate rule for skipped and todo tests. It is a maintenance trap once that is shown: this whole file
 * may be deleted after the change is merged; decision.test.ts keeps the invariants and the skip rule.
 */
import type {
  EvidenceVector,
  FormalClaim,
  Mutant,
  Property,
  TestAssessment,
  TestCase,
  TestPropertyEdge,
} from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { type AssessInput, assessTest, boundaryPoints } from '../src/assess.js';
import { type OutcomeEvidence, outcomeCode, outcomeName, TEST_OUTCOMES } from '../src/decision.js';
import { FLAGS, forEachRecord } from './outcome-space.js';

// ---------------------------------------------------------------------------------------------------------------
// The implementation of assessTest before the outcome decision moved to decision.ts.

function legacyUnlinkedByInference(test: TestCase): boolean {
  const s = test.suspicions;

  if (s.includes('type_level_only') || s.includes('tautological_assertion') || s.includes('no_assertion'))
    return false;
  const linkUnknown =
    s.includes('unresolved_import') ||
    s.includes('opaque_call') ||
    s.includes('progress_only') ||
    s.includes('caller_supplied') ||
    s.includes('reachable_by_name');

  return s.includes('target_not_called') || (!test.targetCalls.some((c) => c.asserted) && !linkUnknown);
}

interface LegacyInputIndex {
  edges: Map<string, AssessInput['edges']>;
  killed: Map<string, AssessInput['mutants']>;
  covered: Map<string, AssessInput['mutants']>;
}

/** Edges and mutants by test id (in input order), so assessing every test does not scan them for each one. */
function legacyIndexOf(input: AssessInput): LegacyInputIndex {
  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const index: LegacyInputIndex = { edges: new Map(), killed: new Map(), covered: new Map() };

  for (const edge of input.edges) push(index.edges, edge.testId, edge);

  for (const mutant of input.mutants) {
    for (const id of new Set(mutant.killedBy)) push(index.killed, id, mutant);
    for (const id of new Set(mutant.coveredBy)) push(index.covered, id, mutant);
  }
  return index;
}

function legacyAssessTest(
  test: TestCase,
  input: AssessInput,
  index: LegacyInputIndex = legacyIndexOf(input),
): TestAssessment {
  const edges = index.edges.get(test.id) ?? [];
  const propertyIds = [...new Set(edges.map((e) => e.propertyId).filter((id): id is string => id !== null))];
  const wanted = new Set(propertyIds);
  const properties = input.properties.filter((p) => wanted.has(p.id));
  const killed = index.killed.get(test.id) ?? [];
  const covered = index.covered.get(test.id) ?? [];
  const survived = covered.filter((m) => m.status === 'survived');
  const relevantKilled = killed.filter((m) => m.relevance === 'spec_relevant');
  const relevantSurvived = survived.filter(
    (m) => m.relevance === 'spec_relevant' && m.propertyIds.some((id) => propertyIds.includes(id)),
  );
  const other = covered.filter((m) => m.status !== 'survived' && m.status !== 'killed');
  const assertedArgs = new Set(
    test.targetCalls
      .filter((c) => c.asserted)
      .flatMap((c) => c.args.filter((a): a is string => a !== null))
      .flatMap(legacyArgumentValues),
  );
  const assertedCall = test.targetCalls.some((c) => c.asserted);
  const unresolved = test.suspicions.includes('unresolved_import');
  const opaque = test.suspicions.includes('opaque_call');
  const progressOnly = test.suspicions.includes('progress_only');
  const callerSupplied = test.suspicions.includes('caller_supplied');
  // Project code could reach what the test reads without being handed it (a mocked module, a global): possible, not
  // shown, so the link is unknown rather than absent.
  const reachable = test.suspicions.includes('reachable_by_name');
  const routes = [...new Set(test.targetCalls.flatMap((c) => c.reachedVia ?? []))];
  // Static analysis could not see everything the test reaches, or the test checks when a call settles rather than
  // what it returns: either way a missing link is not proof of none.
  const linkUnknown = unresolved || opaque || progressOnly || callerSupplied || reachable;

  const boundaryCoverage: EvidenceVector['boundaryCoverage'] = [];

  for (const p of properties) {
    if (!p.predicate) continue;
    const points = boundaryPoints(p.predicate);
    const hit = points.filter((pt) => assertedArgs.has(pt));
    // One test usually checks one side of a boundary; whether both sides are covered is a property-level question.
    boundaryCoverage.push({
      boundary: `${p.predicate.param} ${p.predicate.operator} ${p.predicate.value} (decisive inputs ${points.join(', ')}; asserted: ${hit.join(', ') || 'none'})`,
      exercised: hit.length > 0 ? 'yes' : 'no',
    });
  }
  // Distinguishability claims name the tests whose inputs they checked.
  const testClaims = input.claims.filter(
    (c) =>
      c.kind === 'distinguishability' &&
      Array.isArray(c.scope.testIds) &&
      (c.scope.testIds as unknown[]).includes(test.id),
  );
  const claims = [
    ...input.claims.filter((c) => propertyIds.includes(c.propertyId) && c.kind !== 'distinguishability'),
    ...testClaims,
  ];
  const unknowns: string[] = [];

  // Some reports list a killing test without listing it as covering, so a kill also counts as running the mutant.
  const ranMutants = covered.length > 0 || killed.length > 0;

  if (!input.mutationAvailable)
    unknowns.push('no mutation results for this run; detection power not measured');
  else if (!ranMutants)
    unknowns.push(
      'no mutant of this run is recorded as run by this test (outside the mutation scope, or coverage not reported)',
    );

  if (test.granularity === 'suite') unknowns.push('analysed at suite level only');

  if (test.nondeterminism.length > 0)
    unknowns.push(`non-deterministic inputs: ${test.nondeterminism.join(', ')}`);

  if (test.usesMocks) unknowns.push('uses mocks; observed behaviour may not be the real implementation');

  if (unresolved)
    unknowns.push(
      'a call goes through a relative import TypeScript could not resolve; its link to project code is unknown (see the inventory diagnostics)',
    );
  // A timeout counts as detected for the run, but which covering test would have caught it is not known.
  for (const m of other.filter((m) => m.status === 'timeout' && m.relevance === 'spec_relevant'))
    unknowns.push(`covered mutant ${m.id} timed out; whether this test detects it is not known`);
  if (opaque)
    unknowns.push(
      'runs code in a child process or through a dynamic import; static analysis cannot see which project code it reaches',
    );

  for (const c of claims)
    if (c.status !== 'proven_within_model' && c.status !== 'counterexample_found')
      unknowns.push(`formal claim ${c.id} is ${c.status}`);

  const vector: EvidenceVector = {
    specificationRelevance: properties.map((p) => ({ propertyId: p.id, status: p.status })),
    assertionRelevance: assertedCall
      ? 'checks_result'
      : test.assertionCount === 0
        ? 'none'
        : linkUnknown
          ? 'unknown'
          : 'weak',
    mutationDetection: {
      killed: killed.map((m) => m.id),
      survived: survived.map((m) => m.id),
      other: other.map((m) => m.id),
    },
    boundaryCoverage,
    formalEvidence: claims.map((c) => c.id),
    sourceConfidence: properties.map(
      (p) =>
        `${p.id}: ${p.confidence.sourceQuality} source, ${p.confidence.independence}, ${p.confidence.freshness}, agreement ${p.confidence.agreement}`,
    ),
    unknowns,
  };

  const rationale: string[] = [];
  let outcome: TestAssessment['outcome'];
  const typeLevelOnly = test.suspicions.includes('type_level_only');
  // Static analysis is certain about these: the test asserts nothing, or only constants. A mutant such a test kills
  // can only fail it by making the code it runs throw, so a kill does not make it check a result.
  const assertsNothing =
    test.suspicions.includes('tautological_assertion') || test.suspicions.includes('no_assertion');
  // A killed mutant is evidence against an inferred missing link: the test failed when project code changed, so it
  // does observe project behaviour.
  const unlinked = legacyUnlinkedByInference(test);
  const killEvidence = unlinked && killed.length > 0;
  const disconnected = !typeLevelOnly && (assertsNothing || (unlinked && !killEvidence));

  if (test.modifiers.includes('expected_failure')) {
    // An inverted test passes only when what it asserts fails, so a kill, a survivor or a passing run says the
    // opposite of what its assertions read as; Veritas does not turn that around.
    outcome = 'inconclusive';
    rationale.push(
      'marked as expected to fail (it.fails, test.failing): it passes only when its assertions fail, so its results do not show what its assertions check',
    );
  } else if (typeLevelOnly) {
    // A type check is a real check of the project, but of its types: no run, mutant or solver here evaluates it.
    outcome = 'inconclusive';
    rationale.push(
      'checks only TypeScript types (expectTypeOf, assertType), which Veritas does not evaluate',
    );
  } else if (disconnected) {
    outcome = 'tautological_or_disconnected';

    if (test.suspicions.length) rationale.push(`static analysis: ${test.suspicions.join(', ')}`);

    if (!assertedCall) rationale.push('no assertion checks the result of a project function');

    // Only a test that ran mutants can be said to have missed them; others were outside the mutation scope. Without
    // a full run, it is known to have run only the mutants no test killed: mutator stops at the first failing test.
    if (input.mutationAvailable && covered.length > 0 && killed.length === 0) {
      const known = input.ranMutantIds?.get(test.id);
      const decided = covered.filter((m) => m.status === 'killed' || m.status === 'survived');
      const ran = decided.filter((m) => input.killMatrix || m.status === 'survived' || known?.has(m.id));
      const unchecked = decided.length - ran.length;

      if (ran.length > 0) rationale.push(`killed none of the ${ran.length} mutant(s) it runs`);

      if (unchecked > 0)
        rationale.push(
          `${unchecked} other mutant(s) it covers were killed by another test first, so whether it detects them was not checked`,
        );
    }
  } else if (!assertedCall && !killEvidence) {
    // Only reachable when the link is unknown: the asserted value may come from project code, so do not judge it.
    outcome = 'inconclusive';

    if (unresolved)
      rationale.push(
        'the asserted call could not be linked to a project symbol because its import did not resolve',
      );

    if (opaque)
      rationale.push(
        'the asserted values come from a child process or a dynamic import, which static analysis cannot follow',
      );

    if (progressOnly)
      rationale.push(
        'asserts only on constants recorded after awaiting a project call: it checks that the call settles (does not block), which static analysis cannot link to the call',
      );

    if (reachable)
      rationale.push(
        `project code it calls can reach what it reads (${routes.join('; ') || 'by name'}); not shown to be what the assertion checks`,
      );

    if (callerSupplied)
      rationale.push(
        "registered inside a shared or parameterized suite: what it calls comes from the suite's caller, which static analysis does not follow",
      );
  } else if (killEvidence) {
    // A kill shows the test observes project behaviour, not which property it checks: without an assertion linked
    // to project code, the properties of the functions it calls may not be what it checks.
    outcome = 'inconclusive';
  } else if (properties.some((p) => p.status === 'conflicted')) {
    outcome = 'spec_conflict';
    rationale.push(
      `linked property is conflicted: ${properties
        .filter((p) => p.status === 'conflicted')
        .map((p) => p.id)
        .join(', ')}`,
    );
  } else if (relevantSurvived.length > 0 || boundaryCoverage.some((b) => b.exercised === 'no')) {
    outcome = 'weak_or_incomplete';

    if (relevantSurvived.length > 0) {
      rationale.push(
        `${relevantSurvived.length} specification-relevant mutant(s) it runs survived: ${relevantSurvived.map((m) => `${m.location.file}:${m.location.range?.start} ${m.original} -> ${m.replacement}`).join('; ')}`,
      );
    }

    for (const b of boundaryCoverage.filter((b) => b.exercised === 'no'))
      rationale.push(`boundary not exercised: ${b.boundary}`);

    for (const c of testClaims.filter((c) => relevantSurvived.some((m) => m.id === c.mutantId))) {
      if (c.status === 'counterexample_found')
        rationale.push(
          `its input ${JSON.stringify(c.counterexample)} distinguishes mutant ${c.mutantId} from the original, but no assertion caught it (${c.id})`,
        );
      else if (c.status === 'proven_within_model')
        rationale.push(
          `none of its inputs distinguishes mutant ${c.mutantId}; a new input is needed (${c.id})`,
        );
    }
  } else if (!input.mutationAvailable) {
    outcome = 'inconclusive';
    rationale.push('asserts a project result, but detection power was not measured (no mutation results)');
  } else if (properties.length === 0) {
    outcome = 'inconclusive';
    rationale.push('asserts a project result, but no property is linked to the functions it calls');
  } else if (
    linkUnknown &&
    relevantKilled.length > 0 &&
    boundaryCoverage.every((b) => b.exercised === 'yes')
  ) {
    // Kills are recorded per test, so the code static analysis cannot follow (an unresolved import, a child
    // process or a dynamic import) may be what detected them.
    outcome = 'inconclusive';
    rationale.push(
      `kills ${relevantKilled.length} specification-relevant mutant(s), but ${unresolved ? 'another call goes through an unresolved import' : 'it also runs code in a child process or through a dynamic import'} and may be what detected them`,
    );
  } else if (relevantKilled.length > 0 && boundaryCoverage.every((b) => b.exercised === 'yes')) {
    outcome = 'meaningful_with_evidence';
    rationale.push(
      `kills ${relevantKilled.length} specification-relevant mutant(s) and survivors it covers: none`,
    );

    if (boundaryCoverage.length)
      rationale.push(`exercises decisive inputs: ${boundaryCoverage.map((b) => b.boundary).join('; ')}`);
  } else {
    outcome = 'inconclusive';
    rationale.push(
      ranMutants
        ? 'linked to properties but killed no specification-relevant mutant or boundary coverage is partial'
        : 'linked to properties, but it ran no mutant of this run (outside the mutation scope, or coverage not reported)',
    );
  }

  if (killEvidence)
    rationale.unshift(
      `static analysis could not link an assertion to project code${test.suspicions.length ? ` (${test.suspicions.join(', ')})` : ''}, but it failed when project code was mutated (${killed.length} mutant(s)); which specification it checks is not known without an assertion linked to project code, so it is not judged meaningful or weak`,
    );

  const limitations = [...unknowns];

  if (properties.some((p) => p.status !== 'accepted'))
    limitations.push('linked properties are not accepted; relevance is to proposed specifications');

  return {
    testId: test.id,
    propertyIds,
    evidenceIds: [...new Set(properties.flatMap((p) => p.sourceIds))],
    killedMutantIds: killed.map((m) => m.id),
    survivedMutantIds: survived.map((m) => m.id),
    formalClaimIds: claims.map((c) => c.id),
    vector,
    outcome,
    limitations,
    rationale,
  };
}

function legacyArgumentValues(arg: string): string[] {
  if (!arg.startsWith('[') && !arg.startsWith('{')) return [arg];

  try {
    const parsed = JSON.parse(arg) as unknown;
    const leaves = Object.values(parsed as Record<string, unknown>).filter(
      (v): v is string => typeof v === 'string',
    );

    return Array.isArray(parsed) ? [...leaves, String(parsed.length)] : leaves;
  } catch {
    return [arg];
  }
}

/** The decision of the previous assessTest, transcribed over the abstract record. Meaningful for counts ≥ 0. */
function legacyOutcomeOfRecord(e: OutcomeEvidence): TestAssessment['outcome'] {
  const linkUnknown =
    e.unresolvedImport || e.opaqueCall || e.progressOnly || e.callerSupplied || e.reachableByName;
  const unlinked =
    e.typeLevelOnly || e.assertsNothing ? false : e.targetNotCalled || (!e.assertedCall && !linkUnknown);
  const killEvidence = unlinked && e.killed > 0;
  const disconnected = !e.typeLevelOnly && (e.assertsNothing || (unlinked && !killEvidence));

  if (e.expectedFailure) return 'inconclusive';

  if (e.typeLevelOnly) return 'inconclusive';

  if (disconnected) return 'tautological_or_disconnected';

  if (!e.assertedCall && !killEvidence) return 'inconclusive';

  if (killEvidence) return 'inconclusive';

  if (e.conflictedProperties > 0) return 'spec_conflict';

  if (e.relevantSurvived > 0 || e.unexercisedBoundaries > 0) return 'weak_or_incomplete';

  if (!e.mutationAvailable) return 'inconclusive';

  if (e.linkedProperties === 0) return 'inconclusive';

  if (linkUnknown && e.relevantKilled > 0 && e.unexercisedBoundaries === 0) return 'inconclusive';

  if (e.relevantKilled > 0 && e.unexercisedBoundaries === 0) return 'meaningful_with_evidence';

  return 'inconclusive';
}

/** The record without any mutation result: how the kernel is meant to decide a skipped or todo test. */
function withoutMutationResults(e: OutcomeEvidence): OutcomeEvidence {
  return { ...e, mutationAvailable: false, killed: 0, relevantKilled: 0, relevantSurvived: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Concrete inputs that realise the abstract space through assessTest

/** Each dimension of a scenario with the values it takes. Flags take both values. */
const DIMENSIONS = {
  ...(Object.fromEntries(FLAGS.map((f) => [f, [false, true]])) as Record<(typeof FLAGS)[number], boolean[]>),
  /** Which suspicion stands for `assertsNothing`, and which modifier for `skippedOrTodo`. */
  variant: [false, true],
  kill: ['none', 'unrelated', 'relevant'],
  property: ['none', 'no_predicate', 'exercised', 'unexercised'],
  status: ['accepted', 'proposed', 'conflicted'],
  /** A second linked property without a predicate. */
  second: ['none', 'accepted', 'conflicted'],
  survivor: ['none', 'relevant', 'unrelated', 'unlinked'],
  /** A mutant killed by another test that this test covers. */
  covered: [false, true],
  timeout: [false, true],
  claims: ['none', 'distinguishing', 'indistinguishable', 'unknown'],
  ran: ['none', 'killMatrix', 'ranMutantIds'],
  usesMocks: [false, true],
  suite: [false, true],
  nondeterministic: [false, true],
} as const;

type Dimension = keyof typeof DIMENSIONS;
type Scenario = { [K in Dimension]: (typeof DIMENSIONS)[K][number] };
const DIMENSION_NAMES = Object.keys(DIMENSIONS) as Dimension[];
/** Flags that, when set, take the test away from the full-evidence path: drawn less often, so that path is common. */
const RARE = new Set<string>(FLAGS.filter((f) => f !== 'assertedCall' && f !== 'mutationAvailable'));

/** A small deterministic generator (mulberry32), so that a failure reproduces. */
function random(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random scenarios: each set flag that leads away from a meaningful test is drawn with probability 0.2, the other
 * dimensions uniformly. The test checks that every pair of values of any two dimensions occurs (pairwise
 * coverage) and that every outcome is reached; the abstract record test covers every combination of flags.
 */
function scenarios(count: number): Scenario[] {
  const next = random(20261122);
  const all: Scenario[] = [];

  for (let k = 0; k < count; k++) {
    const s: Record<string, unknown> = {};

    for (const d of DIMENSION_NAMES) {
      const values = DIMENSIONS[d] as readonly unknown[];
      s[d] = RARE.has(d)
        ? next() < 0.2
        : (FLAGS as readonly string[]).includes(d)
          ? next() < 0.8
          : values[Math.floor(next() * values.length)];
    }
    all.push(s as Scenario);
  }

  return all;
}

/** Index of the value of each dimension of a scenario. */
function valueIndexes(s: Scenario): number[] {
  return DIMENSION_NAMES.map((d) => (DIMENSIONS[d] as readonly unknown[]).indexOf(s[d]));
}

function scenarioInput(s: Scenario): { test: TestCase; input: AssessInput } {
  const modifiers: TestCase['modifiers'] = [];

  if (s.expectedFailure) modifiers.push('expected_failure');

  if (s.skippedOrTodo) modifiers.push(s.variant ? 'todo' : 'skip');
  const suspicions: TestCase['suspicions'] = [];
  const add = (on: boolean, suspicion: TestCase['suspicions'][number]) => {
    if (on) suspicions.push(suspicion);
  };
  add(s.typeLevelOnly, 'type_level_only');
  add(s.assertsNothing, s.variant ? 'tautological_assertion' : 'no_assertion');
  add(s.targetNotCalled, 'target_not_called');
  add(s.unresolvedImport, 'unresolved_import');
  add(s.opaqueCall, 'opaque_call');
  add(s.progressOnly, 'progress_only');
  add(s.callerSupplied, 'caller_supplied');
  add(s.reachableByName, 'reachable_by_name');
  const test = {
    id: 'T-a',
    file: 'test/pricing.test.ts',
    name: 'T-a',
    suitePath: [],
    location: { file: 'test/pricing.test.ts', range: { start: 1, end: 1 } },
    modifiers,
    assertionCount: s.assertsNothing ? 0 : 1,
    calledSymbols: ['discountAmount'],
    targetCalls: [
      {
        symbol: 'discountAmount',
        args: ['1000'],
        asserted: s.assertedCall,
        location: { file: 'test/pricing.test.ts' },
        ...(s.reachableByName ? { reachedVia: ['mocked module src/api.ts'] } : {}),
      },
    ],
    usesMocks: s.usesMocks,
    usesSnapshots: false,
    nondeterminism: s.nondeterministic ? ['Date.now'] : [],
    suspicions,
    granularity: s.suite ? 'suite' : 'test',
  } as unknown as TestCase;
  const property = (id: string, status: string, predicate: unknown) =>
    ({
      id,
      status,
      origin: 'normative',
      sourceIds: [`S-${id}`],
      ...(predicate ? { predicate } : {}),
      confidence: {
        sourceQuality: 'primary',
        independence: 'independent',
        freshness: 'current',
        agreement: 1,
      },
    }) as unknown as Property;
  const properties: Property[] = [];

  if (s.property !== 'none')
    properties.push(
      property(
        'P-1',
        s.status,
        s.property === 'no_predicate'
          ? undefined
          : { param: 'total', operator: '>=', value: s.property === 'exercised' ? '1000' : '50' },
      ),
    );

  if (s.second !== 'none') properties.push(property('P-2', s.second, undefined));
  const mutant = (
    id: string,
    status: Mutant['status'],
    relevance: Mutant['relevance'],
    killedBy: string[],
    coveredBy: string[],
    propertyIds = ['P-1'],
  ) =>
    ({
      id,
      status,
      killedBy,
      coveredBy,
      relevance,
      propertyIds,
      location: { file: 'src/pricing.ts', range: { start: 3, end: 3 } },
      original: 'total >= 1000',
      replacement: 'total > 1000',
    }) as unknown as Mutant;
  const mutants: Mutant[] = [];

  if (s.kill !== 'none')
    mutants.push(
      mutant(
        'M-k',
        'killed',
        s.kill === 'relevant' ? 'spec_relevant' : 'unrelated',
        ['T-a'],
        s.covered ? ['T-a'] : [],
      ),
    );

  if (s.survivor !== 'none')
    mutants.push(
      mutant(
        'M-s',
        'survived',
        s.survivor === 'unrelated' ? 'unrelated' : 'spec_relevant',
        [],
        ['T-a'],
        s.survivor === 'unlinked' ? ['P-9'] : ['P-1'],
      ),
    );

  if (s.covered) mutants.push(mutant('M-o', 'killed', 'spec_relevant', ['T-b'], ['T-a', 'T-b']));

  if (s.timeout) mutants.push(mutant('M-t', 'timeout', 'spec_relevant', [], ['T-a']));
  const claim = (id: string, kind: string, status: string, extra: object) =>
    ({
      id,
      propertyId: 'P-1',
      kind,
      status,
      engine: 'z3',
      engineVersion: '4',
      assurance: 'none',
      modelId: 'm',
      assumptions: [],
      scope: { testIds: ['T-a'] },
      semanticGaps: [],
      semanticValidation: 'not_attempted',
      durationMs: 0,
      ...extra,
    }) as unknown as FormalClaim;
  const claims: FormalClaim[] =
    s.claims === 'distinguishing'
      ? [
          claim('C-d', 'distinguishability', 'counterexample_found', {
            mutantId: 'M-s',
            counterexample: { total: '5' },
          }),
        ]
      : s.claims === 'indistinguishable'
        ? [claim('C-i', 'distinguishability', 'proven_within_model', { mutantId: 'M-s' })]
        : s.claims === 'unknown'
          ? [claim('C-u', 'conformance', 'unknown', {})]
          : [];

  return {
    test,
    input: {
      tests: [test],
      edges: properties.map((p) => ({ testId: 'T-a', propertyId: p.id }) as unknown as TestPropertyEdge),
      properties,
      mutants,
      claims,
      functions: [],
      mutationAvailable: s.mutationAvailable,
      ...(s.ran === 'killMatrix' ? { killMatrix: true } : {}),
      ...(s.ran === 'ranMutantIds' ? { ranMutantIds: new Map([['T-a', new Set(['M-o'])]]) } : {}),
    },
  };
}

/** Rationale lines that only mutation results can produce. */
const MUTATION_RATIONALE =
  /failed when project code was mutated|survived:|^kills \d|killed none of|killed by another test first|distinguishes mutant/;

// ---------------------------------------------------------------------------------------------------------------

describe('test outcome kernel against the previous assessTest', () => {
  it('assesses every scenario as before, except that a skipped or todo test ignores its mutation results', () => {
    const all = scenarios(20_000);
    const mismatches: unknown[] = [];
    const outcomes = new Set<string>();
    const changes = new Set<string>();
    // Pair (a, value of a, b, value of b) at index ((a * 8 + va) * 32 + b) * 8 + vb.
    const pairs = new Uint8Array(32 * 8 * 32 * 8);

    for (const s of all) {
      const v = valueIndexes(s);

      for (let a = 0; a < v.length; a++)
        for (let b = a + 1; b < v.length; b++) pairs[((a * 8 + (v[a] ?? 0)) * 32 + b) * 8 + (v[b] ?? 0)] = 1;
      const { test, input } = scenarioInput(s);
      const expected = legacyAssessTest(test, input);
      const actual = assessTest(test, input);
      outcomes.add(expected.outcome);

      if (!s.skippedOrTodo) {
        if (JSON.stringify(actual) !== JSON.stringify(expected) && mismatches.length < 5)
          mismatches.push({ s, expected, actual });
        continue;
      }
      // A skipped or todo test: the outcome is the previous one without mutation results, nothing else but the
      // rationale differs, and no rationale line comes from mutation results.
      const without = legacyAssessTest(test, { ...input, mutants: [], mutationAvailable: false });
      const credited = input.mutants.some((m) => m.killedBy.includes('T-a') || m.coveredBy.includes('T-a'));
      const ok =
        actual.outcome === without.outcome &&
        JSON.stringify({ ...actual, outcome: expected.outcome, rationale: expected.rationale }) ===
          JSON.stringify(expected) &&
        !actual.rationale.some((r) => MUTATION_RATIONALE.test(r)) &&
        actual.rationale.some((r) => r.includes('mutation results credited to it')) === credited;

      if (!ok && mismatches.length < 5) mismatches.push({ s, expected, without, actual });

      if (actual.outcome !== expected.outcome) changes.add(`${expected.outcome} -> ${actual.outcome}`);
    }

    expect(mismatches).toEqual([]);
    expect(DIMENSION_NAMES.length).toBeLessThanOrEqual(32);
    expect([...outcomes].sort()).toEqual([...TEST_OUTCOMES].sort());
    // Every pair of values of any two dimensions occurs.
    let expectedPairs = 0;

    for (const [i, a] of DIMENSION_NAMES.entries())
      for (const b of DIMENSION_NAMES.slice(i + 1))
        expectedPairs += DIMENSIONS[a].length * DIMENSIONS[b].length;
    expect(pairs.reduce((n, x) => n + x, 0)).toBe(expectedPairs);
    // The outcomes that changed are exactly those decided by mutation results: a credited kill no longer makes a
    // skipped test meaningful or overturns a missing link, and a credited survivor no longer makes it weak.
    expect([...changes].sort()).toEqual([
      'inconclusive -> tautological_or_disconnected',
      'meaningful_with_evidence -> inconclusive',
      'weak_or_incomplete -> inconclusive',
    ]);
  });

  // The abstract space includes records no run produces (more relevant kills than kills, conflicted properties
  // without a linked one), so this compares the kernel with the previous decision beyond what assessTest reaches.
  it('decides every abstract record as before, except that a skipped or todo test ignores its mutation results', () => {
    const mismatches: OutcomeEvidence[] = [];
    let changed = 0;
    const total = forEachRecord([0, 1], (e) => {
      const actual = outcomeName(outcomeCode(e));
      const expected = legacyOutcomeOfRecord(e.skippedOrTodo ? withoutMutationResults(e) : e);

      if (actual !== expected && mismatches.length < 5) mismatches.push({ ...e });

      if (actual !== legacyOutcomeOfRecord(e)) changed++;
    });

    expect(total).toBe(2 ** 12 * 2 ** 6);
    expect(mismatches).toEqual([]);
    expect(changed).toBeGreaterThan(0);
  });
});
