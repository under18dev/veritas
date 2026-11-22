import { Mutant, MutantStatus, StageStatus } from '@under18dev/veritas-core';
import { z } from 'zod';

/** Where the mutator binary was found: the analysed project first, then this adapter's own dependency. */
export const MutatorOrigin = z.enum(['project', 'adapter', 'explicit']);
export type MutatorOrigin = z.infer<typeof MutatorOrigin>;

export const MutatorDetection = z.object({
  available: z.boolean(),
  version: z.string().nullable(),
  binPath: z.string().nullable(),
  origin: MutatorOrigin.nullable(),
  /** CLI flags confirmed in `mutator --help`. */
  capabilities: z.array(z.string()),
  detail: z.string(),
});
export type MutatorDetection = z.infer<typeof MutatorDetection>;

/** Statuses a mutation run may end in. `partial` and `skipped` are never produced by this adapter. */
export const MutationRunStatus = StageStatus.extract([
  'succeeded',
  'failed',
  'timeout',
  'error',
  'unsupported',
  'cancelled',
]);
export type MutationRunStatus = z.infer<typeof MutationRunStatus>;

export const MutantCounts = z.record(MutantStatus, z.number().int().nonnegative());
export type MutantCounts = z.infer<typeof MutantCounts>;

/**
 * A second, narrow mutation run that checks the tests static analysis could not link to project code: mutator ran
 * only their test files, on the project sources those files import, with `--kill-matrix` so that every covering
 * test ran every mutant. Its kills and coverage for those tests are merged into the main run's mutants.
 */
export const MutationConfirmation = z.object({
  /** `skipped` when it did not run (nothing to check, too little time left, turned off); see `detail`. */
  status: z.union([MutationRunStatus, z.literal('skipped')]),
  detail: z.string().nullable(),
  /** The tests it checked: those static analysis could not link and the main run credited with no kill. */
  testIds: z.array(z.string()),
  testFiles: z.array(z.string()),
  sourceFiles: z.array(z.string()),
  command: z.array(z.string()),
  durationMs: z.number().nonnegative(),
  counts: MutantCounts,
  /** Checked tests that killed at least one mutant. */
  killedBy: z.array(z.string()),
  /** For each checked test, the mutants (ids of the main run) it ran to a verdict, killed or survived. */
  ranBy: z.record(z.string(), z.array(z.string())),
  /** Mutants killed in this run that the main run had decided otherwise (survived, no coverage); not merged. */
  inconsistent: z.array(z.string()),
  /**
   * Mutants the main run left undecided (pending, unknown) that this run killed: the stage counts them as killed,
   * and each carries a `statusReason` saying so.
   */
  adopted: z.array(z.string()).default([]),
  warnings: z.array(z.string()),
});
export type MutationConfirmation = z.infer<typeof MutationConfirmation>;

export const MutationRunResult = z.object({
  status: MutationRunStatus,
  /** Human-readable reason for a non-success status (redacted stderr summary, missing binary, ...). */
  detail: z.string().nullable(),
  /** `mizchi` when Veritas ran mutator; `imported` for an existing mutation-testing-elements report. */
  backend: z.object({ name: z.enum(['mizchi', 'imported']), version: z.string().nullable() }),
  /** Exact argv: the Node executable, the mutator CLI script and its arguments. Empty when nothing ran. */
  command: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  mutants: z.array(Mutant),
  counts: MutantCounts,
  rawReportPath: z.string().nullable(),
  agentReport: z.unknown().nullable(),
  killMatrix: z.unknown().nullable(),
  warnings: z.array(z.string()),
  /**
   * Source files (project-relative) left out of the run because the bundler could not parse their instrumented
   * copy. Their mutants were not run, so the results do not cover them.
   */
  excludedFiles: z.array(z.string()).optional(),
  /**
   * What mutator was told about type-checking: `auto` (its default: type-check mutants with the project's
   * TypeScript when it finds it) or `off` (`--no-typecheck`). Absent when mutator was not run.
   */
  typecheck: z.enum(['auto', 'off']).optional(),
  /**
   * Set when mutator stopped starting mutants because its `--time-budget` ran out. The mutants it did not run are
   * `pending`, and the results cover only part of the code in scope, whatever `--since` selected.
   */
  timeBudgetExhausted: z
    .object({ seconds: z.number().int().nonnegative(), notRun: z.number().int().nonnegative() })
    .optional(),
  /**
   * Set when mutator did not print how many test files the test runner config selected, so Veritas could not check
   * that the selected tests ran. The mutation stage is `partial`.
   */
  testRunUnverified: z.literal(true).optional(),
  /** The run that checked the tests static analysis could not link; absent when the stage did not try one. */
  confirmation: MutationConfirmation.optional(),
});
export type MutationRunResult = z.infer<typeof MutationRunResult>;

export function emptyCounts(): MutantCounts {
  return Object.fromEntries(MutantStatus.options.map((s) => [s, 0])) as MutantCounts;
}

export function countMutants(mutants: readonly Mutant[]): MutantCounts {
  const counts = emptyCounts();

  for (const m of mutants) counts[m.status] += 1;

  return counts;
}
