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
import {
  invariant_assertsNothingIsTautological,
  invariant_expectedFailureIsInconclusive,
  invariant_killedIsNotTautological,
  invariant_killedWithoutLinkIsInconclusive,
  invariant_meaningfulNeedsEvidence,
  invariant_noMutationNeverMeaningful,
  invariant_outcomeInRange,
  invariant_reachableByNameNeverMeaningful,
  invariant_reachableByNameWithoutAssertedCallIsInconclusive,
  invariant_typeLevelOnlyIsInconclusive,
  OUTCOME_RULE,
  type OutcomeEvidence,
  outcomeCode,
  outcomeName,
  outcomeOfRule,
  outcomeRule,
  TEST_OUTCOMES,
} from '../src/decision.js';

// ---------------------------------------------------------------------------------------------------------------
// The implementation of assessTest before the outcome decision moved to decision.ts, kept as the oracle.

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

// ---------------------------------------------------------------------------------------------------------------
// The abstract evidence space

const FLAGS = [
  'expectedFailure',
  'typeLevelOnly',
  'assertsNothing',
  'targetNotCalled',
  'assertedCall',
  'unresolvedImport',
  'opaqueCall',
  'progressOnly',
  'callerSupplied',
  'reachableByName',
  'mutationAvailable',
] as const satisfies readonly (keyof OutcomeEvidence)[];
const COUNTS = [
  'killed',
  'relevantKilled',
  'relevantSurvived',
  'linkedProperties',
  'conflictedProperties',
  'unexercisedBoundaries',
] as const satisfies readonly (keyof OutcomeEvidence)[];

/**
 * Calls `visit` with every record whose flags take both values and whose counts take each of `values`. The record
 * is reused between calls; copy it to keep it.
 */
function forEachRecord(values: readonly number[], visit: (e: OutcomeEvidence) => void): number {
  const e = Object.fromEntries([...FLAGS, ...COUNTS].map((k) => [k, false])) as unknown as OutcomeEvidence;
  const record = e as unknown as Record<string, number | boolean>;
  const total = 2 ** FLAGS.length * values.length ** COUNTS.length;

  for (let i = 0; i < total; i++) {
    let rest = i;

    for (const flag of FLAGS) {
      record[flag] = rest % 2 === 1;
      rest = Math.floor(rest / 2);
    }

    for (const count of COUNTS) {
      record[count] = values[rest % values.length] as number;
      rest = Math.floor(rest / values.length);
    }
    visit(e);
  }

  return total;
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

// ---------------------------------------------------------------------------------------------------------------
// Concrete inputs that realise the abstract space through assessTest

type PropertyShape = 'none' | 'no_predicate' | 'exercised' | 'unexercised';

interface Scenario {
  flags: Record<(typeof FLAGS)[number], boolean>;
  /** Which suspicion stands for `assertsNothing`. */
  variant: boolean;
  kill: 'none' | 'unrelated' | 'relevant';
  property: PropertyShape;
  conflicted: boolean;
  survivor: boolean;
  covered: boolean;
}

function scenarioInput(s: Scenario): { test: TestCase; input: AssessInput } {
  const f = s.flags;
  const modifiers: TestCase['modifiers'] = [];

  if (f.expectedFailure) modifiers.push('expected_failure');

  const suspicions: TestCase['suspicions'] = [];
  const add = (on: boolean, suspicion: TestCase['suspicions'][number]) => {
    if (on) suspicions.push(suspicion);
  };
  add(f.typeLevelOnly, 'type_level_only');
  add(f.assertsNothing, s.variant ? 'tautological_assertion' : 'no_assertion');
  add(f.targetNotCalled, 'target_not_called');
  add(f.unresolvedImport, 'unresolved_import');
  add(f.opaqueCall, 'opaque_call');
  add(f.progressOnly, 'progress_only');
  add(f.callerSupplied, 'caller_supplied');
  add(f.reachableByName, 'reachable_by_name');
  const test = {
    id: 'T-a',
    file: 'test/pricing.test.ts',
    name: 'T-a',
    suitePath: [],
    location: { file: 'test/pricing.test.ts', range: { start: 1, end: 1 } },
    modifiers,
    assertionCount: f.assertsNothing ? 0 : 1,
    calledSymbols: ['discountAmount'],
    targetCalls: [
      {
        symbol: 'discountAmount',
        args: ['1000'],
        asserted: f.assertedCall,
        location: { file: 'test/pricing.test.ts' },
        ...(f.reachableByName ? { reachedVia: ['mocked module src/api.ts'] } : {}),
      },
    ],
    usesMocks: false,
    usesSnapshots: false,
    nondeterminism: [],
    suspicions,
    granularity: 'test',
  } as unknown as TestCase;
  const properties: Property[] =
    s.property === 'none'
      ? []
      : [
          {
            id: 'P-1',
            status: s.conflicted ? 'conflicted' : 'accepted',
            origin: 'normative',
            sourceIds: ['S-readme'],
            ...(s.property === 'no_predicate'
              ? {}
              : {
                  predicate: {
                    param: 'total',
                    operator: '>=',
                    value: s.property === 'exercised' ? '1000' : '50',
                  },
                }),
            confidence: {
              sourceQuality: 'primary',
              independence: 'independent',
              freshness: 'current',
              agreement: 1,
            },
          } as unknown as Property,
        ];
  const mutant = (
    id: string,
    status: Mutant['status'],
    relevance: Mutant['relevance'],
    killedBy: string[],
    coveredBy: string[],
  ) =>
    ({
      id,
      status,
      killedBy,
      coveredBy,
      relevance,
      propertyIds: ['P-1'],
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

  if (s.survivor) mutants.push(mutant('M-s', 'survived', 'spec_relevant', [], ['T-a']));

  if (s.covered) mutants.push(mutant('M-o', 'killed', 'spec_relevant', ['T-b'], ['T-a', 'T-b']));
  const edges = properties.map((p) => ({ testId: 'T-a', propertyId: p.id }) as unknown as TestPropertyEdge);
  const claims: FormalClaim[] = [];

  return {
    test,
    input: {
      tests: [test],
      edges,
      properties,
      mutants,
      claims,
      functions: [],
      mutationAvailable: f.mutationAvailable,
    },
  };
}

function* scenarios(): Generator<Scenario> {
  const kills: Scenario['kill'][] = ['none', 'unrelated', 'relevant'];
  const shapes: PropertyShape[] = ['none', 'no_predicate', 'exercised', 'unexercised'];

  for (let bits = 0; bits < 2 ** FLAGS.length; bits++) {
    const flags = Object.fromEntries(FLAGS.map((k, i) => [k, ((bits >> i) & 1) === 1])) as Scenario['flags'];

    for (const variant of [false, true])
      for (const kill of kills)
        for (const property of shapes)
          for (const conflicted of property === 'none' ? [false] : [false, true])
            for (const survivor of [false, true])
              for (const covered of [false, true])
                yield { flags, variant, kill, property, conflicted, survivor, covered };
  }
}

// ---------------------------------------------------------------------------------------------------------------

describe('test outcome decision kernel', () => {
  it('matches the previous assessTest on every scenario', () => {
    let cases = 0;
    const mismatches: unknown[] = [];
    const outcomes = new Set<string>();

    for (const s of scenarios()) {
      cases++;
      const { test, input } = scenarioInput(s);
      const expected = legacyAssessTest(test, input);
      const actual = assessTest(test, input);
      outcomes.add(expected.outcome);

      if (JSON.stringify(actual) !== JSON.stringify(expected) && mismatches.length < 5)
        mismatches.push({ s, expected, actual });
    }

    expect(mismatches).toEqual([]);
    expect(cases).toBe(2 ** FLAGS.length * 2 * 3 * (1 + 3 * 2) * 2 * 2);
    expect([...outcomes].sort()).toEqual([...TEST_OUTCOMES].sort());
  }, 120_000);

  // The abstract space includes records no run produces (more relevant kills than kills, conflicted properties
  // without a linked one), so this compares the kernel with the previous decision beyond what assessTest reaches.
  it('matches the previous decision over the abstract record', () => {
    const mismatches: OutcomeEvidence[] = [];
    const total = forEachRecord([0, 1, 2], (e) => {
      if (outcomeName(outcomeCode(e)) !== legacyOutcomeOfRecord(e) && mismatches.length < 5)
        mismatches.push({ ...e });
    });

    expect(total).toBe(2 ** 11 * 3 ** 6);
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('maps rules to outcomes', () => {
    expect(
      Object.entries(OUTCOME_RULE).map(([name, rule]) => [name, outcomeName(outcomeOfRule(rule))]),
    ).toEqual([
      ['expectedFailure', 'inconclusive'],
      ['typeLevelOnly', 'inconclusive'],
      ['disconnected', 'tautological_or_disconnected'],
      ['linkUnknown', 'inconclusive'],
      ['killedWithoutLink', 'inconclusive'],
      ['specConflict', 'spec_conflict'],
      ['weak', 'weak_or_incomplete'],
      ['noMutationResults', 'inconclusive'],
      ['noLinkedProperty', 'inconclusive'],
      ['killsThroughUnknownLink', 'inconclusive'],
      ['noRelevantKill', 'inconclusive'],
      ['meaningful', 'meaningful_with_evidence'],
    ]);
    expect(() => outcomeName(TEST_OUTCOMES.length)).toThrow(/unknown test outcome/);
    expect(() => outcomeName(-1)).toThrow(/unknown test outcome/);
  });

  // An exhaustive test over a reduced domain (every flag, every count in {-1, 0, 1}), not a proof: the kernel only
  // compares counts with 0, which this test does not check. Counts are never negative in a run; -1 is there
  // because a model whose integer domain includes negative numbers must reach the same conclusions.
  it('holds every invariant over a reduced domain', () => {
    const invariants = {
      invariant_meaningfulNeedsEvidence,
      invariant_reachableByNameNeverMeaningful,
      invariant_reachableByNameWithoutAssertedCallIsInconclusive,
      invariant_killedIsNotTautological,
      invariant_assertsNothingIsTautological,
      invariant_expectedFailureIsInconclusive,
      invariant_typeLevelOnlyIsInconclusive,
      invariant_killedWithoutLinkIsInconclusive,
      invariant_noMutationNeverMeaningful,
      invariant_outcomeInRange,
    };
    const entries = Object.entries(invariants);
    const violations: Record<string, OutcomeEvidence[]> = {};
    const rules = new Set<number>();

    const total = forEachRecord([-1, 0, 1], (e) => {
      rules.add(outcomeRule(e));

      for (const [name, holds] of entries)
        if (!holds(e)) {
          const list = violations[name] ?? [];
          violations[name] = list;

          if (list.length < 3) list.push({ ...e });
        }
    });

    expect(total).toBe(2 ** 11 * 3 ** 6);
    expect(violations).toEqual({});
    expect([...rules].sort((a, b) => a - b)).toEqual(Object.values(OUTCOME_RULE));
  }, 120_000);
});
