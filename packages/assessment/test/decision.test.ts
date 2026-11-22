import type { Mutant, Property, TestCase, TestPropertyEdge } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { type AssessInput, assessTest } from '../src/assess.js';
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
  invariant_skippedIgnoresMutationResults,
  invariant_skippedNeverMeaningful,
  invariant_specConflictNeedsConflict,
  invariant_tautologicalNeedsStaticFinding,
  invariant_typeLevelOnlyIsInconclusive,
  invariant_unknownLinkWithoutAssertedCallIsInconclusive,
  invariant_weakNeedsGap,
  OUTCOME_RULE,
  type OutcomeEvidence,
  outcomeCode,
  outcomeName,
  outcomeOfRule,
  outcomeRule,
  TEST_OUTCOMES,
} from '../src/decision.js';
import { evidence, forEachRecord } from './outcome-space.js';

const INVARIANTS = {
  invariant_meaningfulNeedsEvidence,
  invariant_reachableByNameNeverMeaningful,
  invariant_reachableByNameWithoutAssertedCallIsInconclusive,
  invariant_killedIsNotTautological,
  invariant_assertsNothingIsTautological,
  invariant_expectedFailureIsInconclusive,
  invariant_typeLevelOnlyIsInconclusive,
  invariant_skippedNeverMeaningful,
  invariant_killedWithoutLinkIsInconclusive,
  invariant_noMutationNeverMeaningful,
  invariant_outcomeInRange,
  invariant_specConflictNeedsConflict,
  invariant_weakNeedsGap,
  invariant_tautologicalNeedsStaticFinding,
  invariant_unknownLinkWithoutAssertedCallIsInconclusive,
  invariant_skippedIgnoresMutationResults,
};

/** A test asserting `discountAmount(1000)`, linked to `total >= 1000`, that kills a relevant mutant. */
function meaningfulInput(
  modifiers: TestCase['modifiers'],
  mutants: Mutant[],
): { test: TestCase; input: AssessInput } {
  const test = {
    id: 'T-a',
    file: 'test/pricing.test.ts',
    name: 'T-a',
    suitePath: [],
    location: { file: 'test/pricing.test.ts', range: { start: 1, end: 1 } },
    modifiers,
    assertionCount: 1,
    calledSymbols: ['discountAmount'],
    targetCalls: [
      {
        symbol: 'discountAmount',
        args: ['1000'],
        asserted: true,
        location: { file: 'test/pricing.test.ts' },
      },
    ],
    usesMocks: false,
    usesSnapshots: false,
    nondeterminism: [],
    suspicions: [],
    granularity: 'test',
  } as unknown as TestCase;
  const property = {
    id: 'P-1',
    status: 'accepted',
    origin: 'normative',
    sourceIds: ['S-readme'],
    predicate: { param: 'total', operator: '>=', value: '1000' },
    confidence: { sourceQuality: 'primary', independence: 'independent', freshness: 'current', agreement: 1 },
  } as unknown as Property;

  return {
    test,
    input: {
      tests: [test],
      edges: [{ testId: 'T-a', propertyId: 'P-1' } as unknown as TestPropertyEdge],
      properties: [property],
      mutants,
      claims: [],
      functions: [],
      mutationAvailable: true,
    },
  };
}

function mutant(id: string, status: Mutant['status'], killedBy: string[]): Mutant {
  return {
    id,
    status,
    killedBy,
    coveredBy: ['T-a'],
    relevance: 'spec_relevant',
    propertyIds: ['P-1'],
    location: { file: 'src/pricing.ts', range: { start: 3, end: 3 } },
    original: 'total >= 1000',
    replacement: 'total > 1000',
  } as unknown as Mutant;
}

describe('test outcome decision kernel', () => {
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
      ['skippedOrTodo', 'inconclusive'],
      ['noMutationResults', 'inconclusive'],
      ['noLinkedProperty', 'inconclusive'],
      ['killsThroughUnknownLink', 'inconclusive'],
      ['noRelevantKill', 'inconclusive'],
      ['meaningful', 'meaningful_with_evidence'],
    ]);
    expect(() => outcomeName(TEST_OUTCOMES.length)).toThrow(/unknown test outcome/);
    expect(() => outcomeName(-1)).toThrow(/unknown test outcome/);
  });

  it('does not judge a skipped or todo test on the mutation results credited to it', () => {
    const kill = meaningfulInput(['skip'], [mutant('M-1', 'killed', ['T-a'])]);
    expect(assessTest({ ...kill.test, modifiers: [] }, kill.input).outcome).toBe('meaningful_with_evidence');
    const skipped = assessTest(kill.test, kill.input);
    expect(skipped.outcome).toBe('inconclusive');
    expect(skipped.rationale).toEqual([
      'skipped or marked todo, so it does not run: it is not judged on mutation results, and static analysis finds nothing that decides it',
      'skipped or marked todo, so it does not run: the mutation results credited to it (1 killed, 0 survived) are not evidence of what it checks and are not used',
    ]);
    // The credited results stay in the evidence vector.
    expect(skipped.killedMutantIds).toEqual(['M-1']);

    // A credited survivor does not make it weak either.
    const survivor = meaningfulInput(['todo'], [mutant('M-2', 'survived', [])]);
    expect(assessTest({ ...survivor.test, modifiers: [] }, survivor.input).outcome).toBe(
      'weak_or_incomplete',
    );
    const todo = assessTest(survivor.test, survivor.input);
    expect(todo.outcome).toBe('inconclusive');
    expect(todo.rationale.join(' ')).not.toMatch(/survived:/);
  });

  it('keeps the static outcomes of a skipped test', () => {
    // An unexercised boundary is read from the test's own asserted inputs, not from mutation results.
    const { test, input } = meaningfulInput(['skip'], []);
    const boundary = {
      ...input,
      properties: input.properties.map((p) => ({
        ...p,
        predicate: { param: 'total', operator: '>=', value: '50' },
      })),
    } as AssessInput;
    expect(assessTest(test, boundary).outcome).toBe('weak_or_incomplete');
    const conflicted = {
      ...input,
      properties: input.properties.map((p) => ({ ...p, status: 'conflicted' })),
    } as AssessInput;
    expect(assessTest(test, conflicted).outcome).toBe('spec_conflict');
    const constant = { ...test, suspicions: ['tautological_assertion'] } as TestCase;
    expect(assessTest(constant, input).outcome).toBe('tautological_or_disconnected');
    // A kill credited to a skipped test does not overturn a missing link.
    const unlinked = { ...test, targetCalls: [{ ...test.targetCalls[0], asserted: false }] } as TestCase;
    expect(assessTest(unlinked, { ...input, mutants: [mutant('M-1', 'killed', ['T-a'])] }).outcome).toBe(
      'tautological_or_disconnected',
    );
  });

  // An exhaustive test over a reduced domain, not a proof: every flag, with every count in {0, 1} and again in
  // {-1, 1}. The kernel only compares each count with 0 on its own (not checked here), so mixing -1 and 0 in one
  // record adds nothing. Counts are never negative in a run; -1 is there because a model whose integer domain
  // includes negative numbers must reach the same conclusions.
  it('holds every invariant over a reduced domain', () => {
    const entries = Object.entries(INVARIANTS);
    const violations: Record<string, OutcomeEvidence[]> = {};
    const rules = new Set<number>();
    const check = (e: OutcomeEvidence) => {
      rules.add(outcomeRule(e));

      for (const [name, holds] of entries)
        if (!holds(e)) {
          const list = violations[name] ?? [];
          violations[name] = list;

          if (list.length < 3) list.push({ ...e });
        }
    };
    const total = forEachRecord([0, 1], check) + forEachRecord([-1, 1], check);

    expect(total).toBe(2 * 2 ** 12 * 2 ** 6);
    expect(violations).toEqual({});
    expect([...rules].sort((a, b) => a - b)).toEqual(Object.values(OUTCOME_RULE));
  }, 30_000);

  it('decides a few records as documented', () => {
    const meaningful = evidence({
      assertedCall: true,
      mutationAvailable: true,
      killed: 1,
      relevantKilled: 1,
      linkedProperties: 1,
    });
    expect(outcomeName(outcomeCode(meaningful))).toBe('meaningful_with_evidence');
    expect(outcomeName(outcomeCode({ ...meaningful, skippedOrTodo: true }))).toBe('inconclusive');
    expect(outcomeName(outcomeCode({ ...meaningful, relevantSurvived: 1 }))).toBe('weak_or_incomplete');
    expect(outcomeName(outcomeCode({ ...meaningful, relevantSurvived: 1, skippedOrTodo: true }))).toBe(
      'inconclusive',
    );
    expect(outcomeName(outcomeCode({ ...meaningful, linkedProperties: -1 }))).toBe('inconclusive');
  });
});
