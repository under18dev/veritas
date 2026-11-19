import { z } from 'zod';

/** Result of a formal verification attempt. `proven_within_model` is scoped to the stated model and bounds. */
export const VerificationStatus = z.enum([
  'proven_within_model',
  'counterexample_found',
  'unknown',
  'unsupported',
  'timeout',
  'semantic_mismatch',
  'error',
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/** Review state of a specification property. Only an explicit approval record may produce `accepted`. */
export const SpecificationStatus = z.enum([
  'proposed',
  'reviewed',
  'accepted',
  'rejected',
  'conflicted',
  'superseded',
]);
export type SpecificationStatus = z.infer<typeof SpecificationStatus>;

/** Where a property claim comes from. `inferred` and `observed` never count as independent normative evidence. */
export const PropertyOrigin = z.enum(['normative', 'inferred', 'observed', 'human']);
export type PropertyOrigin = z.infer<typeof PropertyOrigin>;

/**
 * Normalized mutant outcome. A survived mutant is never `equivalent_proven` without a bounded proof;
 * use `suspected_equivalent` when equivalence is only plausible.
 */
export const MutantStatus = z.enum([
  'killed',
  'survived',
  'timeout',
  'compile_error',
  'runtime_error',
  'ignored',
  'no_coverage',
  'pending',
  'unknown',
  'suspected_equivalent',
  'equivalent_proven',
]);
export type MutantStatus = z.infer<typeof MutantStatus>;

export const TestOutcome = z.enum([
  'meaningful_with_evidence',
  'weak_or_incomplete',
  'tautological_or_disconnected',
  'spec_conflict',
  'inconclusive',
]);
export type TestOutcome = z.infer<typeof TestOutcome>;

export const ImprovementOutcome = z.enum([
  'improved',
  'no_safe_improvement',
  'needs_spec_decision',
  'blocked',
  'error',
]);
export type ImprovementOutcome = z.infer<typeof ImprovementOutcome>;

/** Trust hierarchy used when presenting a claim. Never collapsed into a single numeric score. */
export const TrustLevel = z.enum([
  'proven',
  'falsified',
  'empirically_supported',
  'inferred',
  'conflicted',
  'unknown',
  'unsupported',
]);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const CapabilityState = z.enum(['available', 'degraded', 'unavailable', 'disabled']);
export type CapabilityState = z.infer<typeof CapabilityState>;

/** Outcome of one pipeline stage. `unsupported` and `skipped` are not successes. */
export const StageStatus = z.enum([
  'succeeded',
  'failed',
  'partial',
  'skipped',
  'unsupported',
  'error',
  'cancelled',
]);
export type StageStatus = z.infer<typeof StageStatus>;

export const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof Severity>;

/** Whether a finding is confirmed by execution/solver evidence or only suspected. */
export const FindingCertainty = z.enum(['confirmed', 'suspected', 'informational']);
export type FindingCertainty = z.infer<typeof FindingCertainty>;
