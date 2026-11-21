import type { FormalClaim, Mutant, Property, TestCase, TestPropertyEdge } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { type AssessInput, assessTest, boundaryPoints } from '../src/index.js';

const location = { file: 'src/pricing.ts', range: { start: 3, end: 3 } };

function testCase(overrides: Partial<TestCase> & { id: string }): TestCase {
  return {
    file: 'test/pricing.test.ts',
    name: overrides.id,
    suitePath: [],
    location: { file: 'test/pricing.test.ts', range: { start: 1, end: 1 } },
    modifiers: [],
    assertionCount: 1,
    calledSymbols: ['discountAmount'],
    targetCalls: [],
    usesMocks: false,
    usesSnapshots: false,
    nondeterminism: [],
    suspicions: [],
    granularity: 'test',
    ...overrides,
  } as TestCase;
}

function call(args: string[], asserted = true): TestCase['targetCalls'][number] {
  return { symbol: 'discountAmount', args, asserted, location: { file: 'test/pricing.test.ts' } } as never;
}

function property(status: Property['status'] = 'accepted'): Property {
  return {
    id: 'P-discount',
    status,
    origin: 'normative',
    sourceIds: ['S-readme'],
    predicate: { param: 'total', operator: '>=', value: '1000' },
    confidence: { sourceQuality: 'primary', independence: 'independent', freshness: 'current', agreement: 1 },
  } as unknown as Property;
}

function mutant(id: string, status: Mutant['status'], killedBy: string[], coveredBy: string[]): Mutant {
  return {
    id,
    status,
    killedBy,
    coveredBy,
    relevance: 'spec_relevant',
    propertyIds: ['P-discount'],
    location,
    original: 'total >= 1000',
    replacement: 'total > 1000',
  } as unknown as Mutant;
}

function input(overrides: Partial<AssessInput> = {}): AssessInput {
  const edges: TestPropertyEdge[] = ['T-a', 'T-b', 'T-c'].map(
    (testId) => ({ testId, propertyId: 'P-discount' }) as unknown as TestPropertyEdge,
  );

  return {
    tests: [],
    edges,
    properties: [property()],
    mutants: [],
    claims: [],
    functions: [],
    mutationAvailable: true,
    ...overrides,
  };
}

describe('boundaryPoints', () => {
  it('returns both sides of each threshold', () => {
    expect(boundaryPoints({ param: 'x', operator: '>=', value: '1000' } as never)).toEqual(['999', '1000']);
    expect(boundaryPoints({ param: 'x', operator: '>', value: '1000' } as never)).toEqual(['1000', '1001']);
    expect(boundaryPoints({ param: 'x', operator: '==', value: '0' } as never)).toEqual(['-1', '0', '1']);
  });
});

describe('assessTest', () => {
  it('calls a constant assertion tautological even when the test kills mutants by accident', () => {
    const t = testCase({
      id: 'T-a',
      suspicions: ['tautological_assertion'],
      targetCalls: [call(['1000'], false)],
    });
    const a = assessTest(t, input({ mutants: [mutant('M-1', 'killed', ['T-a'], ['T-a'])] }));
    expect(a.outcome).toBe('tautological_or_disconnected');
    expect(a.rationale.join(' ')).toMatch(/no assertion checks the result/);
  });

  it('says a disconnected test killed no mutant only when it ran mutants, not when it was outside the scope', () => {
    const t = testCase({ id: 'T-a', suspicions: ['no_assertion'], assertionCount: 0 });
    const ran = assessTest(t, input({ mutants: [mutant('M-1', 'survived', [], ['T-a', 'T-b'])] }));
    expect(ran.outcome).toBe('tautological_or_disconnected');
    expect(ran.rationale).toContain('killed none of the 1 mutant(s) it runs');

    const outside = assessTest(t, input({ mutants: [mutant('M-1', 'survived', [], ['T-b'])] }));
    expect(outside.outcome).toBe('tautological_or_disconnected');
    expect(outside.rationale.join(' ')).not.toMatch(/killed/);
    expect(outside.vector.unknowns.join(' ')).toMatch(
      /no mutant of this run is recorded as run by this test/,
    );

    // A kill counts as running the mutant even when the report does not list the test as covering it.
    const killedOnly = assessTest(t, input({ mutants: [mutant('M-1', 'killed', ['T-a'], [])] }));
    expect(killedOnly.vector.unknowns.join(' ')).not.toMatch(/no mutant of this run/);
  });

  it('is inconclusive, not disconnected, when the asserted call goes through an unresolved import', () => {
    const t = testCase({ id: 'T-a', calledSymbols: [], suspicions: ['unresolved_import'] });
    const a = assessTest(t, input());
    expect(a.outcome).toBe('inconclusive');
    expect(a.vector.assertionRelevance).toBe('unknown');
    expect(a.rationale.join(' ')).toMatch(/import did not resolve/);
    expect(a.limitations.join(' ')).toMatch(/could not resolve/);
  });

  it('is inconclusive, not disconnected, when the test checks only types', () => {
    const t = testCase({ id: 'T-a', calledSymbols: [], suspicions: ['type_level_only'] });
    const a = assessTest(t, input({ mutants: [mutant('M-1', 'survived', [], ['T-a'])] }));
    expect(a.outcome).toBe('inconclusive');
    expect(a.rationale.join(' ')).toMatch(/checks only TypeScript types/);
  });

  it('still calls a constant assertion tautological when an import is also unresolved', () => {
    const t = testCase({
      id: 'T-a',
      calledSymbols: [],
      suspicions: ['tautological_assertion', 'unresolved_import'],
    });
    expect(assessTest(t, input()).outcome).toBe('tautological_or_disconnected');
  });

  it('is meaningful only with an asserted call, a killed relevant mutant and the boundary exercised', () => {
    const t = testCase({ id: 'T-a', targetCalls: [call(['1000'])] });
    const a = assessTest(t, input({ mutants: [mutant('M-1', 'killed', ['T-a'], ['T-a'])] }));
    expect(a.outcome).toBe('meaningful_with_evidence');
    expect(a.vector.boundaryCoverage[0]?.exercised).toBe('yes');
    expect(a.killedMutantIds).toEqual(['M-1']);
  });

  it('is not meaningful when another call goes through an unresolved import, since it may have caused the kills', () => {
    const t = testCase({ id: 'T-a', targetCalls: [call(['1000'])], suspicions: ['unresolved_import'] });
    const a = assessTest(t, input({ mutants: [mutant('M-1', 'killed', ['T-a'], ['T-a'])] }));
    expect(a.outcome).toBe('inconclusive');
    expect(a.killedMutantIds).toEqual(['M-1']);
    expect(a.rationale.join(' ')).toMatch(/unresolved import/);
  });

  it('is not meaningful when the test also runs code static analysis cannot follow', () => {
    const t = testCase({ id: 'T-a', targetCalls: [call(['1000'])], suspicions: ['opaque_call'] });
    const a = assessTest(t, input({ mutants: [mutant('M-1', 'killed', ['T-a'], ['T-a'])] }));
    expect(a.outcome).toBe('inconclusive');
    expect(a.rationale.join(' ')).toMatch(/child process or through a dynamic import/);
  });

  it('lists a covered timeout mutant as unknown instead of crediting it as a kill', () => {
    const t = testCase({ id: 'T-a', targetCalls: [call(['1000'])] });
    const a = assessTest(
      t,
      input({ mutants: [mutant('M-1', 'killed', ['T-a'], ['T-a']), mutant('M-2', 'timeout', [], ['T-a'])] }),
    );
    expect(a.killedMutantIds).toEqual(['M-1']);
    expect(a.vector.unknowns.join(' ')).toMatch(/M-2 timed out/);
    expect(a.limitations.join(' ')).toMatch(/M-2 timed out/);
  });

  it('is weak when a relevant mutant it runs survives', () => {
    const t = testCase({ id: 'T-b', targetCalls: [call(['1000'])] });
    const a = assessTest(
      t,
      input({
        mutants: [mutant('M-1', 'killed', ['T-b'], ['T-b']), mutant('M-2', 'survived', [], ['T-b'])],
      }),
    );
    expect(a.outcome).toBe('weak_or_incomplete');
    expect(a.survivedMutantIds).toEqual(['M-2']);
  });

  it('says whether the inputs of a weak test distinguish its surviving mutant, from distinguishability claims', () => {
    const claim = (id: string, testId: string, status: FormalClaim['status'], counterexample?: object) =>
      ({
        id,
        kind: 'distinguishability',
        propertyId: 'P-discount',
        mutantId: 'M-2',
        status,
        scope: { testIds: [testId] },
        ...(counterexample ? { counterexample } : {}),
      }) as unknown as FormalClaim;
    const mutants = [
      mutant('M-1', 'killed', ['T-b'], ['T-b']),
      mutant('M-2', 'survived', [], ['T-b', 'T-a']),
    ];
    const claims = [
      claim('C-weak', 'T-b', 'counterexample_found', { total: '1000' }),
      claim('C-other', 'T-a', 'proven_within_model'),
    ];
    const weak = assessTest(
      testCase({ id: 'T-b', targetCalls: [call(['1000'])] }),
      input({ mutants, claims }),
    );
    expect(weak.outcome).toBe('weak_or_incomplete');
    expect(weak.rationale.join(' ')).toContain(
      'its input {"total":"1000"} distinguishes mutant M-2 from the original, but no assertion caught it (C-weak)',
    );
    expect(weak.formalClaimIds).toEqual(['C-weak']);
    const other = assessTest(
      testCase({ id: 'T-a', targetCalls: [call(['2000'])] }),
      input({ mutants, claims }),
    );
    expect(other.rationale.join(' ')).toContain(
      'none of its inputs distinguishes mutant M-2; a new input is needed (C-other)',
    );
    expect(other.formalClaimIds).toEqual(['C-other']);
  });

  it('is weak when the decisive boundary is never asserted', () => {
    const t = testCase({ id: 'T-b', targetCalls: [call(['2000'])] });
    const a = assessTest(t, input({ mutants: [mutant('M-1', 'killed', ['T-b'], ['T-b'])] }));
    expect(a.outcome).toBe('weak_or_incomplete');
    expect(a.rationale.join(' ')).toMatch(/boundary not exercised/);
  });

  it('reports spec_conflict when a linked property is conflicted', () => {
    const t = testCase({ id: 'T-c', targetCalls: [call(['1000'])] });
    const a = assessTest(t, input({ properties: [property('conflicted')] }));
    expect(a.outcome).toBe('spec_conflict');
  });

  it('stays inconclusive without mutation results instead of guessing', () => {
    const t = testCase({ id: 'T-a', targetCalls: [call(['1000'])] });
    const a = assessTest(t, input({ mutationAvailable: false }));
    expect(a.outcome).toBe('inconclusive');
    expect(a.vector.unknowns.join(' ')).toMatch(/detection power not measured/);
  });

  it('stays inconclusive when no property is linked', () => {
    const t = testCase({ id: 'T-z', targetCalls: [call(['1000'])] });
    const a = assessTest(t, input({ mutants: [mutant('M-1', 'killed', ['T-z'], ['T-z'])] }));
    expect(a.outcome).toBe('inconclusive');
  });

  it('keeps the evidence as a vector and lists unaccepted properties and mocks as limitations', () => {
    const t = testCase({ id: 'T-a', targetCalls: [call(['1000'])], usesMocks: true });
    const a = assessTest(
      t,
      input({ properties: [property('proposed')], mutants: [mutant('M-1', 'killed', ['T-a'], ['T-a'])] }),
    );
    expect(Object.keys(a.vector).sort()).toEqual([
      'assertionRelevance',
      'boundaryCoverage',
      'formalEvidence',
      'mutationDetection',
      'sourceConfidence',
      'specificationRelevance',
      'unknowns',
    ]);
    expect(a).not.toHaveProperty('score');
    expect(a.limitations.join(' ')).toMatch(/not accepted/);
    expect(a.limitations.join(' ')).toMatch(/uses mocks/);
  });
});
