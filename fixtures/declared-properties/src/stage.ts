/** Evidence a mutation stage decides its status on. Every count is the number of items of that kind. */
export interface StageEvidence {
  failed: boolean;
  undecided: number;
  excluded: number;
  notRun: number;
  testsRan: number;
}

/**
 * Stage status: 0 succeeded, 1 partial, 2 failed. Deliberately missing the rule that at least one test must have
 * run before the stage may succeed.
 */
export function unguardedStatus(e: StageEvidence): number {
  if (e.failed) return 2;

  if (e.undecided > 0 || e.excluded > 0 || e.notRun > 0) return 1;

  return 0;
}

/** The same status, partial when no test ran. */
export function guardedStatus(e: StageEvidence): number {
  if (e.testsRan <= 0) return 1;

  return unguardedStatus(e);
}

/** Holds: the guarded status succeeds only after a test ran. */
export function invariant_guardedSucceededNeedsTests(e: StageEvidence): boolean {
  return guardedStatus(e) !== 0 || e.testsRan >= 1;
}

/** Does not hold, on purpose: the unguarded status succeeds with no test at all. */
export function invariant_unguardedSucceededNeedsTests(e: StageEvidence): boolean {
  return unguardedStatus(e) !== 0 || e.testsRan >= 1;
}

/** Not a holds_for_all target: it returns a number. */
export function statusCode(e: StageEvidence): number {
  return guardedStatus(e) * 10;
}

/** Not a holds_for_all target: loops are outside the formal subset. */
export function invariant_loops(n: number): boolean {
  let total = 0;

  for (let i = 0; i < n; i++) total += i;

  return total >= 0;
}

/** Not a holds_for_all target: it is not exported. */
function invariant_hidden(e: StageEvidence): boolean {
  return e.testsRan >= e.testsRan;
}

export const notAFunction = invariant_hidden.name;
