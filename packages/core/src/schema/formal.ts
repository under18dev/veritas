import { z } from 'zod';
import { Id } from './common.js';
import { VerificationStatus } from './status.js';

export const ClaimKind = z.enum([
  'conformance',
  'distinguishability',
  'bounded_equivalence',
  'property_detection',
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

/** A proof claim is assumptions + model + property + scope + tool result. Prose alone is never a proof. */
export const FormalClaim = z.object({
  id: Id,
  propertyId: Id,
  kind: ClaimKind,
  status: VerificationStatus,
  engine: z.string(),
  engineVersion: z.string(),
  /** `kernel_checked` only for a Lean kernel check without sorry/admit/extra axioms. */
  assurance: z.enum(['smt_bounded', 'kernel_checked', 'none']),
  modelId: z.string(),
  assumptions: z.array(z.string()),
  scope: z.record(z.string(), z.unknown()),
  semanticGaps: z.array(z.string()),
  solverInputArtifact: z.string().optional(),
  solverOutputArtifact: z.string().optional(),
  counterexample: z.record(z.string(), z.unknown()).optional(),
  reproduction: z.string().optional(),
  semanticValidation: z.enum(['confirmed', 'mismatch', 'not_attempted']),
  durationMs: z.number().nonnegative(),
  mutantId: Id.optional(),
});
export type FormalClaim = z.infer<typeof FormalClaim>;
