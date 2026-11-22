import type { OutcomeEvidence } from '../src/decision.js';

/** The flags of the abstract evidence record of the test outcome kernel. */
export const FLAGS = [
  'expectedFailure',
  'skippedOrTodo',
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

/** The counts of the abstract evidence record. */
export const COUNTS = [
  'killed',
  'relevantKilled',
  'relevantSurvived',
  'linkedProperties',
  'conflictedProperties',
  'unexercisedBoundaries',
] as const satisfies readonly (keyof OutcomeEvidence)[];

/** A record with every flag false and every count 0, with `overrides` applied. */
export function evidence(overrides: Partial<OutcomeEvidence> = {}): OutcomeEvidence {
  return {
    ...(Object.fromEntries([
      ...FLAGS.map((k) => [k, false]),
      ...COUNTS.map((k) => [k, 0]),
    ]) as OutcomeEvidence),
    ...overrides,
  };
}

/**
 * Calls `visit` with every record whose flags take both values and whose counts take each of `values`, and returns
 * how many there were. The record is reused between calls; copy it to keep it.
 */
export function forEachRecord(values: readonly number[], visit: (e: OutcomeEvidence) => void): number {
  const e = evidence();
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
