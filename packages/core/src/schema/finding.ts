import { z } from 'zod';
import { Id, Location } from './common.js';
import { FindingCertainty, Severity } from './status.js';

export const FindingKind = z.enum([
  'spec_implementation_mismatch',
  'spec_conflict',
  'test_gap',
  'tautological_test',
  'survived_mutant',
  'counterexample',
  'spec_violation_candidate',
  'unsupported_semantics',
  'stage_failure',
]);
export type FindingKind = z.infer<typeof FindingKind>;

/** Every finding has a stable ID and links to the artifacts that support it (see `veritas explain`). */
export const Finding = z.object({
  id: Id,
  kind: FindingKind,
  title: z.string(),
  severity: Severity,
  certainty: FindingCertainty,
  locations: z.array(Location),
  propertyIds: z.array(Id),
  sourceIds: z.array(Id),
  testIds: z.array(Id),
  mutantIds: z.array(Id),
  claimIds: z.array(Id),
  explanation: z.array(z.string()).min(1),
  nextActions: z.array(z.string()),
});
export type Finding = z.infer<typeof Finding>;
