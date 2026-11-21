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
