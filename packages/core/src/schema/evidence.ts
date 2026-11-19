import { z } from 'zod';
import { Id, IsoDate, Sha256, SourceRange } from './common.js';

export const EvidenceKind = z.enum([
  'readme',
  'docs',
  'standard',
  'code',
  'test',
  'issue',
  'pr',
  'git',
  'runtime',
  'web',
  'human',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/**
 * One piece of collected evidence. `summary` is a short paraphrase, never the full text.
 * `derivedFrom` links copies and derived documents so they are not counted as independent sources.
 */
export const EvidenceSource = z.object({
  id: Id,
  kind: EvidenceKind,
  locator: z.string(),
  revision: z.string().optional(),
  range: SourceRange.optional(),
  capturedAt: IsoDate,
  contentHash: Sha256,
  derivedFrom: z.array(Id),
  summary: z.string().max(2000),
  /** Remote or repository content is untrusted data. It is never interpreted as an instruction. */
  trust: z.literal('untrusted_data'),
});
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** Confidence is presented as separate dimensions, never as a self-reported percentage. */
export const SourceConfidence = z.object({
  sourceQuality: z.enum(['primary', 'secondary', 'derived', 'implementation', 'unknown']),
  agreement: z.enum(['agree', 'disagree', 'mixed', 'single_source', 'unknown']),
  implementationAlignment: z.enum(['agree', 'disagree', 'unknown']),
  independence: z.enum(['independent', 'circular', 'derived', 'unknown']),
  freshness: z.enum(['current', 'stale', 'unknown']),
});
export type SourceConfidence = z.infer<typeof SourceConfidence>;
