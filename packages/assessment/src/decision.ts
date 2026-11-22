import type { TestOutcome } from '@under18dev/veritas-core';

/**
 * Decision kernel of a test assessment: maps an abstract evidence record (flags and counts) to the rule that
 * decides the outcome and to the outcome itself. `assessTest` in `assess.ts` is the shell: it reads the test case,
 * mutants, properties and claims, builds the record, calls this kernel and writes the rationale and the evidence
 * vector.
 *
 * The file is kept in the subset that the formal translator reads, so that the rules can be proved within a
 * bounded model:
 * - no runtime imports (type-only imports are fine) and calls only to functions in this file;
 * - parameters and results are numbers, booleans or flat records of numbers and booleans;
 * - inside the kernel functions, only `const`, `if`, the conditional operator, `&&`, `||`, `!` and comparisons;
 *   no `let`, `switch`, loops, array methods, `??` or `as` (the lookup tables outside the functions may use
 *   `as const`);
 * - every count is compared with 0 on its own, never summed first, so that the rules mean the same over a model
 *   whose integer domain includes negative numbers (a negative count is treated like 0).
 *
 * Outcomes and rules are encoded as small integers; `outcomeName` and the `TEST_OUTCOMES` table turn them back
 * into the status vocabulary outside the kernel functions. The rules only decide over the abstract record: how
 * the record is read from a test case and the mutation report is outside this file and is covered by tests.
 */

/** Outcomes indexed by their code in this kernel. */
export const TEST_OUTCOMES: readonly TestOutcome[] = [
  'meaningful_with_evidence',
  'weak_or_incomplete',
  'tautological_or_disconnected',
  'spec_conflict',
  'inconclusive',
];

/** Rule codes returned by `outcomeRule`, in the order the rules are tried. */
export const OUTCOME_RULE = {
  /** Marked as expected to fail (`it.fails`, `test.failing`): its results say the opposite of its assertions. */
  expectedFailure: 0,
  /** Checks only TypeScript types, which no run, mutant or solver evaluates. */
  typeLevelOnly: 1,
  /** Asserts nothing or only constants, or static analysis found no link and no mutant overturned that. */
  disconnected: 2,
  /** No asserted project call and the link is unknown (unresolved import, child process, name reach, ...). */
  linkUnknown: 3,
  /** Static analysis found no link, but the test killed a mutant: it observes project code, not which property. */
  killedWithoutLink: 4,
  /** A linked property is conflicted. */
  specConflict: 5,
  /** A relevant mutant it runs survived, or a decisive boundary is not exercised. */
  weak: 6,
  /** The run has no mutation results. */
  noMutationResults: 7,
  /** No property is linked to the functions it calls. */
  noLinkedProperty: 8,
  /** Kills relevant mutants, but code static analysis cannot follow may be what detected them. */
  killsThroughUnknownLink: 9,
  /** Linked to properties but killed no specification-relevant mutant. */
  noRelevantKill: 10,
  /** Skipped or marked todo: it does not run, so mutation results credited to it are not its evidence. */
  skippedOrTodo: 11,
  /** Asserts a project call, kills relevant mutants, no relevant survivors, every boundary exercised. */
  meaningful: 12,
} as const;

/** Abstract evidence a test outcome is decided on. Counts are numbers of items of that kind for this test. */
export interface OutcomeEvidence {
  /** The test has the `expected_failure` modifier. */
  expectedFailure: boolean;
  /** The test has the `skip` or the `todo` modifier. */
  skippedOrTodo: boolean;
  /** Suspicion `type_level_only`. */
  typeLevelOnly: boolean;
  /** Suspicion `no_assertion` or `tautological_assertion`: static analysis is certain it checks no result. */
  assertsNothing: boolean;
  /** Suspicion `target_not_called`. */
  targetNotCalled: boolean;
  /** Some call to a project function has its result asserted. */
  assertedCall: boolean;
  /** Suspicion `unresolved_import`. */
  unresolvedImport: boolean;
  /** Suspicion `opaque_call`. */
  opaqueCall: boolean;
  /** Suspicion `progress_only`. */
  progressOnly: boolean;
  /** Suspicion `caller_supplied`. */
  callerSupplied: boolean;
  /** Suspicion `reachable_by_name`. */
  reachableByName: boolean;
  /** The run has mutation results. */
  mutationAvailable: boolean;
  /** Mutants the test killed. */
  killed: number;
  /** Specification-relevant mutants the test killed. */
  relevantKilled: number;
  /** Specification-relevant mutants of a linked property that the test covers and that survived. */
  relevantSurvived: number;
  /** Properties linked to the test. */
  linkedProperties: number;
  /** Linked properties whose status is `conflicted`. */
  conflictedProperties: number;
  /** Decisive boundaries of linked threshold properties that no asserted call exercises. */
  unexercisedBoundaries: number;
}

/**
 * Static analysis could not see everything the test reaches, or the test checks when a call settles rather than
 * what it returns: either way a missing link is not proof of none.
 */
export function linkUnknown(e: OutcomeEvidence): boolean {
  return e.unresolvedImport || e.opaqueCall || e.progressOnly || e.callerSupplied || e.reachableByName;
}

/**
 * Static analysis calls the test disconnected only because it found no link from an assertion to project code:
 * an inference a killed mutant overturns, unlike a test that asserts nothing, only constants or only types.
 */
export function inferredUnlinked(e: OutcomeEvidence): boolean {
  if (e.typeLevelOnly || e.assertsNothing) return false;

  return e.targetNotCalled || (!e.assertedCall && !linkUnknown(e));
}

/** The test was unlinked by inference but killed a mutant: it does observe project behaviour. */
export function killedWithoutLink(e: OutcomeEvidence): boolean {
  return inferredUnlinked(e) && e.killed > 0;
}

/**
 * The rule that decides the outcome (an `OUTCOME_RULE` code). A test that asserts nothing or only constants
 * stays disconnected even when it killed a mutant: such a test can only fail when the code it runs throws.
 */
export function outcomeRule(e: OutcomeEvidence): number {
  if (e.expectedFailure) return 0;

  if (e.typeLevelOnly) return 1;

  const unlinked = inferredUnlinked(e);
  const killedUnlinked = killedWithoutLink(e);

  if (e.assertsNothing || (unlinked && !killedUnlinked)) return 2;

  if (!e.assertedCall && !killedUnlinked) return 3;

  if (killedUnlinked) return 4;

  if (e.conflictedProperties > 0) return 5;

  if (e.relevantSurvived > 0 || e.unexercisedBoundaries > 0) return 6;

  if (!e.mutationAvailable) return 7;

  if (e.linkedProperties <= 0) return 8;

  if (linkUnknown(e) && e.relevantKilled > 0) return 9;

  if (e.relevantKilled <= 0) return 10;

  if (e.skippedOrTodo) return 11;

  return 12;
}

/** Outcome code (an index into `TEST_OUTCOMES`) of a rule code. */
export function outcomeOfRule(rule: number): number {
  if (rule === 12) return 0;

  if (rule === 6) return 1;

  if (rule === 2) return 2;

  if (rule === 5) return 3;

  return 4;
}

/** Outcome code of an evidence record. */
export function outcomeCode(e: OutcomeEvidence): number {
  return outcomeOfRule(outcomeRule(e));
}

/** Name of an outcome code. Throws on a code outside `TEST_OUTCOMES`. */
export function outcomeName(outcome: number): TestOutcome {
  const name = TEST_OUTCOMES[outcome];

  if (name === undefined) throw new Error(`unknown test outcome code ${outcome}`);

  return name;
}

// ---------------------------------------------------------------------------------------------------------------
// Invariants. Each predicate must be true for every record; the exhaustive test checks them over a reduced
// domain, and they are written so that the formal translator can read them.

/**
 * `meaningful_with_evidence` only with the full evidence: an asserted project call, a relevant kill, mutation
 * results, a linked property, no unexercised boundary, no relevant survivor, no conflict, a known link, and a
 * test that runs normally (not expected to fail, not type-level only, not skipped or todo).
 */
export function invariant_meaningfulNeedsEvidence(e: OutcomeEvidence): boolean {
  return (
    outcomeCode(e) !== 0 ||
    (e.assertedCall &&
      e.relevantKilled > 0 &&
      e.mutationAvailable &&
      e.linkedProperties > 0 &&
      e.unexercisedBoundaries <= 0 &&
      e.relevantSurvived <= 0 &&
      e.conflictedProperties <= 0 &&
      !e.expectedFailure &&
      !e.typeLevelOnly &&
      !e.assertsNothing &&
      !linkUnknown(e) &&
      !e.skippedOrTodo)
  );
}

/** A link only possible by name (`reachable_by_name`) never makes a test meaningful. */
export function invariant_reachableByNameNeverMeaningful(e: OutcomeEvidence): boolean {
  return !e.reachableByName || outcomeCode(e) !== 0;
}

/**
 * A test whose only missing link is unknown (name reach, with no asserted call and no certainty that it asserts
 * nothing or calls no target) is inconclusive, whether or not it killed mutants: never tautological.
 */
export function invariant_reachableByNameWithoutAssertedCallIsInconclusive(e: OutcomeEvidence): boolean {
  return (
    !e.reachableByName || e.assertedCall || e.assertsNothing || e.targetNotCalled || outcomeCode(e) === 4
  );
}

/** A test that killed a mutant and is not known to assert nothing is never tautological or disconnected. */
export function invariant_killedIsNotTautological(e: OutcomeEvidence): boolean {
  return e.killed <= 0 || e.assertsNothing || outcomeCode(e) !== 2;
}

/** A test that asserts nothing or only constants is tautological, unless it is expected to fail or type-level. */
export function invariant_assertsNothingIsTautological(e: OutcomeEvidence): boolean {
  return !e.assertsNothing || e.expectedFailure || e.typeLevelOnly || outcomeCode(e) === 2;
}

/** A test expected to fail is always inconclusive. */
export function invariant_expectedFailureIsInconclusive(e: OutcomeEvidence): boolean {
  return !e.expectedFailure || outcomeCode(e) === 4;
}

/** A test that checks only types is always inconclusive. */
export function invariant_typeLevelOnlyIsInconclusive(e: OutcomeEvidence): boolean {
  return !e.typeLevelOnly || outcomeCode(e) === 4;
}

/** A skipped or todo test is never meaningful, whatever mutation results are credited to it. */
export function invariant_skippedNeverMeaningful(e: OutcomeEvidence): boolean {
  return !e.skippedOrTodo || outcomeCode(e) !== 0;
}

/** A test unlinked by inference that killed a mutant is inconclusive: neither meaningful, weak nor tautological. */
export function invariant_killedWithoutLinkIsInconclusive(e: OutcomeEvidence): boolean {
  return !killedWithoutLink(e) || outcomeCode(e) === 4;
}

/** Without mutation results a test is never meaningful. */
export function invariant_noMutationNeverMeaningful(e: OutcomeEvidence): boolean {
  return e.mutationAvailable || outcomeCode(e) !== 0;
}

/** Every record gets an outcome code inside `TEST_OUTCOMES`. */
export function invariant_outcomeInRange(e: OutcomeEvidence): boolean {
  const outcome = outcomeCode(e);

  return outcome >= 0 && outcome <= 4;
}
