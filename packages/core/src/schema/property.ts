import { z } from 'zod';
import { Id, IsoDate } from './common.js';
import { SourceConfidence } from './evidence.js';
import { PropertyIR } from './ir.js';
import { PropertyOrigin, SpecificationStatus } from './status.js';

export const PropertyTemplate = z.enum([
  'boundary',
  'monotonicity',
  'commutativity',
  'idempotence',
  'inverse',
  'exception_condition',
  'round_trip',
  'state_invariant',
  'custom',
]);
export type PropertyTemplate = z.infer<typeof PropertyTemplate>;

export const Property = z.object({
  id: Id,
  version: z.number().int().positive(),
  description: z.string(),
  template: PropertyTemplate,
  targetSymbols: z.array(z.string()),
  status: SpecificationStatus,
  origin: PropertyOrigin,
  sourceIds: z.array(Id),
  assumptions: z.array(z.string()),
  inputDomain: z.record(z.string(), z.unknown()),
  formalExpression: z.string().optional(),
  ir: PropertyIR.optional(),
  conflictsWith: z.array(Id),
  supersededBy: Id.optional(),
  confidence: SourceConfidence,
  /** Statically inferred behaviour and runtime observations are kept apart. */
  implementationAgreement: z.enum(['agree', 'disagree', 'unknown']),
  experimental: z.boolean(),
  reviewedBy: z.string().optional(),
});
export type Property = z.infer<typeof Property>;

/** Every accept/reject is recorded with who, when, what and why, including local operations. */
export const Approval = z.object({
  id: Id,
  propertyId: Id,
  propertyVersion: z.number().int().positive(),
  decision: z.enum(['accept', 'reject', 'review', 'supersede']),
  actor: z.string().min(1),
  reason: z.string().min(1),
  decidedAt: IsoDate,
  sourceIds: z.array(Id),
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalLedger = z.object({
  schemaVersion: z.string(),
  approvals: z.array(Approval),
});
export type ApprovalLedger = z.infer<typeof ApprovalLedger>;
