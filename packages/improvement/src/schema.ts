import { Id, ImprovementBudget, ImprovementOutcome, ImprovementPlan, Sha256 } from '@veritas/core';
import { z } from 'zod';

/** A planner outcome: `planned` when a plan is ready for approval, otherwise why the loop stopped. */
export const PlanOutcome = z.union([z.literal('planned'), ImprovementOutcome]);
export type PlanOutcome = z.infer<typeof PlanOutcome>;

/** Scalar input/expected values: integers as decimal strings (exact), booleans as booleans. */
export const ScalarValue = z.union([z.string().regex(/^-?\d+$/), z.boolean()]);
export type ScalarValue = z.infer<typeof ScalarValue>;

/**
 * One file operation of a patch. Only `add` is ever produced by the planner; the other operations exist so a
 * tampered plan is parsed and then rejected by validation instead of being silently reinterpreted.
 */
export const PatchFile = z.object({
  operation: z.enum(['add', 'modify', 'delete']),
  path: z.string(),
  content: z.string(),
});
export type PatchFile = z.infer<typeof PatchFile>;

/** A concrete test case whose expected value was computed from the specification model only. */
export const ProposedTest = z.object({
  id: Id,
  propertyId: Id,
  symbol: z.string(),
  exportName: z.string(),
  /** Project-relative module of the function under test. */
  module: z.string(),
  params: z.array(z.string()),
  input: z.record(z.string(), ScalarValue),
  expected: ScalarValue,
  /** Why this input: a distinguishing input of a survived mutant or a boundary of the property. */
  origin: z.enum(['survived_mutant', 'boundary']),
  mutantId: Id.optional(),
  claimId: Id.optional(),
  findingId: Id.optional(),
  citations: z.array(z.string()),
  /** How the expected value was derived (property, clause, recorded assumptions). */
  derivation: z.string(),
});
export type ProposedTest = z.infer<typeof ProposedTest>;

/** A planned test that fails against the current implementation. It is never added and never adjusted. */
export const SpecViolationCandidate = z.object({
  id: Id,
  test: ProposedTest,
  /** What the implementation returned in the sandbox, as text. */
  actual: z.string(),
  reason: z.string(),
});
export type SpecViolationCandidate = z.infer<typeof SpecViolationCandidate>;

/** Separate artifact: the implementation, not the test, probably needs to change (or the spec needs a decision). */
export const ImplementationFixProposal = z.object({
  id: Id,
  kind: z.literal('implementation_fix_proposal'),
  propertyId: Id,
  symbol: z.string(),
  module: z.string(),
  input: z.record(z.string(), ScalarValue),
  expectedBySpecification: ScalarValue,
  actualByImplementation: z.string(),
  citations: z.array(z.string()),
  explanation: z.array(z.string()).min(1),
  candidateId: Id,
});
export type ImplementationFixProposal = z.infer<typeof ImplementationFixProposal>;

/** A planned input that was dropped, with the reason (kept so nothing disappears silently). */
export const SkippedTarget = z.object({
  propertyId: Id.nullable(),
  mutantId: Id.optional(),
  input: z.record(z.string(), ScalarValue).optional(),
  reason: z.string(),
});
export type SkippedTarget = z.infer<typeof SkippedTarget>;

/** Everything `apply` needs, persisted as `.veritas/improvements/<planId>/plan.json`. */
export const PlanDocument = z.object({
  planId: Id,
  runId: Id,
  outcome: PlanOutcome,
  plan: ImprovementPlan.nullable(),
  files: z.array(PatchFile),
  tests: z.array(ProposedTest),
  specViolationCandidates: z.array(SpecViolationCandidate),
  implementationFixProposals: z.array(ImplementationFixProposal),
  skipped: z.array(SkippedTarget),
  reasons: z.array(z.string()),
  budget: ImprovementBudget,
  /** Hash of every project file (excluding node_modules, .git, .veritas, .mutator) when the plan was made. */
  projectHash: Sha256,
  configHash: Sha256,
  /** The run artifacts' source hash, for traceability. */
  runSourceHash: Sha256,
});
export type PlanDocument = z.infer<typeof PlanDocument>;

export const PlanResult = z.object({
  planId: Id,
  runId: Id,
  outcome: PlanOutcome,
  plan: ImprovementPlan.nullable(),
  /** sha256 of the canonical plan content; `null` when there is nothing to apply. */
  approvalToken: Sha256.nullable(),
  specViolationCandidates: z.array(SpecViolationCandidate),
  implementationFixProposals: z.array(ImplementationFixProposal),
  skipped: z.array(SkippedTarget),
  reasons: z.array(z.string()),
  /** Project-relative path of the persisted plan. */
  planFile: z.string(),
});
export type PlanResult = z.infer<typeof PlanResult>;
