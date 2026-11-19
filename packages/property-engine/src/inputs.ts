import { EvidenceSource } from '@veritas/core';
import { z } from 'zod';

/** Structural copy of the discovery output this engine consumes (kept local to avoid coupling to its internals). */
export const ThresholdRelation = z.object({
  kind: z.literal('threshold'),
  quantity: z.string(),
  operator: z.enum(['<', '<=', '>', '>=', '==']),
  value: z.string().regex(/^-?\d+$/),
  consequence: z.string(),
});
export type ThresholdRelation = z.infer<typeof ThresholdRelation>;

export const StatementInput = z.object({
  id: z.string(),
  sourceId: z.string(),
  range: z.object({ start: z.number().int(), end: z.number().int() }),
  quote: z.string(),
  modality: z.enum(['must', 'should', 'may', 'descriptive']),
  subjects: z.array(z.string()),
  relation: z.union([ThresholdRelation, z.object({ kind: z.literal('free_text') })]),
  flags: z.array(z.string()),
});
export type StatementInput = z.infer<typeof StatementInput>;

export const DiscoveryInput = z.object({
  sources: z.array(EvidenceSource),
  statements: z.array(StatementInput),
  provenance: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      relation: z.enum(['duplicate_of', 'derived_from', 'supersedes']),
    }),
  ),
});
export type DiscoveryInput = z.infer<typeof DiscoveryInput>;
