import { z } from 'zod';
import { Id, IsoDate } from './common.js';
import { ImprovementOutcome } from './status.js';

export const ImprovementBudget = z.object({
  maxIterations: z.number().int().positive(),
  maxPatchFiles: z.number().int().positive(),
  maxTestRetries: z.number().int().nonnegative(),
  timeBudgetMs: z.number().int().positive(),
  tokenBudget: z.number().int().nonnegative(),
  solverTimeoutMs: z.number().int().positive(),
});
export type ImprovementBudget = z.infer<typeof ImprovementBudget>;

export const ImprovementPlan = z.object({
  id: Id,
  goal: z.string(),
  targetedPropertyIds: z.array(Id),
  observedGaps: z.array(z.object({ findingId: Id, description: z.string() })),
  proposedTestCases: z.array(
    z.object({
      file: z.string(),
      name: z.string(),
      input: z.record(z.string(), z.unknown()),
      rationale: z.string(),
    }),
  ),
  patchPreview: z.string(),
  expectedImpact: z.array(z.string()),
  risks: z.array(z.string()),
  commands: z.array(z.string()),
  budget: ImprovementBudget,
  /** Only test files may be touched without a separate approval. */
  touchesProductionCode: z.boolean(),
  createdAt: IsoDate,
});
export type ImprovementPlan = z.infer<typeof ImprovementPlan>;

export const MeasurementSnapshot = z.object({
  testsPassed: z.number().int().nonnegative(),
  testsFailed: z.number().int().nonnegative(),
  mutantsKilled: z.number().int().nonnegative(),
  mutantsSurvived: z.number().int().nonnegative(),
  claimStatuses: z.record(z.string(), z.string()),
});
export type MeasurementSnapshot = z.infer<typeof MeasurementSnapshot>;

export const PatchAttempt = z.object({
  id: Id,
  planId: Id,
  approvalId: Id.nullable(),
  workspace: z.string(),
  patch: z.string(),
  before: MeasurementSnapshot.nullable(),
  after: MeasurementSnapshot.nullable(),
  rolledBack: z.boolean(),
  outcome: ImprovementOutcome,
  reasons: z.array(z.string()),
  implementationFixProposalId: Id.optional(),
});
export type PatchAttempt = z.infer<typeof PatchAttempt>;
