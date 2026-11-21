import type { FunctionInfo } from '@under18dev/veritas-code-intelligence';
import type {
  EvidenceVector,
  FormalClaim,
  Mutant,
  Property,
  TestAssessment,
  TestCase,
  TestPropertyEdge,
} from '@under18dev/veritas-core';

/** Integer points that decide a threshold: both sides of `x op v`. */
export function boundaryPoints(predicate: NonNullable<Property['predicate']>): string[] {
  const v = BigInt(predicate.value);

  switch (predicate.operator) {
    case '>':
      return [v.toString(), (v + 1n).toString()];
    case '>=':
      return [(v - 1n).toString(), v.toString()];
    case '<':
      return [(v - 1n).toString(), v.toString()];
    case '<=':
      return [v.toString(), (v + 1n).toString()];
    case '==':
      return [(v - 1n).toString(), v.toString(), (v + 1n).toString()];
  }
}

export interface AssessInput {
  tests: TestCase[];
  edges: TestPropertyEdge[];
  properties: Property[];
  mutants: Mutant[];
  claims: FormalClaim[];
  functions: FunctionInfo[];
  /** Whether mutation results exist for this run; without them detection power is unknown. */
  mutationAvailable: boolean;
}

/**
 * Assess each test from an evidence vector. Outcomes:
 * - tautological_or_disconnected: no assertion on a project call (constant assertions, no call, no assertion);
 * - spec_conflict: a linked property is conflicted;
 * - weak_or_incomplete: a relevant mutant it covers survived, or a decisive boundary is not exercised;
 * - meaningful_with_evidence: asserts a project call, kills relevant mutants, no relevant survivors it covers,
 *   and exercises the boundary of every linked threshold property;
 * - inconclusive: anything that cannot be decided (e.g. no mutation data, no linked property).
 */
export function assessTest(test: TestCase, input: AssessInput): TestAssessment {
  const edges = input.edges.filter((e) => e.testId === test.id);
  const propertyIds = [...new Set(edges.map((e) => e.propertyId).filter((id): id is string => id !== null))];
  const properties = input.properties.filter((p) => propertyIds.includes(p.id));
  const killed = input.mutants.filter((m) => m.killedBy.includes(test.id));
  const covered = input.mutants.filter((m) => m.coveredBy.includes(test.id));
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
      .flatMap(argumentValues),
  );
  const assertedCall = test.targetCalls.some((c) => c.asserted);
  const unresolved = test.suspicions.includes('unresolved_import');
  const opaque = test.suspicions.includes('opaque_call');
  // Static analysis could not see everything the test reaches, so a missing link is not proof of none.
  const linkUnknown = unresolved || opaque;

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
  const disconnected =
    !typeLevelOnly &&
    (test.suspicions.includes('tautological_assertion') ||
      test.suspicions.includes('target_not_called') ||
      test.suspicions.includes('no_assertion') ||
      (!assertedCall && !linkUnknown));

  if (typeLevelOnly) {
    // A type check is a real check of the project, but of its types: no run, mutant or solver here evaluates it.
    outcome = 'inconclusive';
    rationale.push(
      'checks only TypeScript types (expectTypeOf, assertType), which Veritas does not evaluate',
    );
  } else if (disconnected) {
    outcome = 'tautological_or_disconnected';

    if (test.suspicions.length) rationale.push(`static analysis: ${test.suspicions.join(', ')}`);

    if (!assertedCall) rationale.push('no assertion checks the result of a project function');

    // Only a test that ran mutants can be said to have missed them; others were outside the mutation scope.
    if (input.mutationAvailable && covered.length > 0 && killed.length === 0)
      rationale.push(`killed none of the ${covered.length} mutant(s) it runs`);
  } else if (!assertedCall) {
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
      'linked to properties but killed no specification-relevant mutant or boundary coverage is partial',
    );
  }

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

export function assessTests(input: AssessInput): TestAssessment[] {
  return input.tests.map((t) => assessTest(t, input));
}

/**
 * The values a literal argument supplies for boundary checks: the literal itself, or for a recorded array or
 * object literal (JSON) its number fields and elements and, for an array, its length.
 */
function argumentValues(arg: string): string[] {
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
