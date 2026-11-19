import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0';

export const Id = z.string().min(1).max(200);
export const IsoDate = z.iso.datetime({ offset: true });
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest');

/** Metadata that every persisted artifact carries, so any result can be traced to its inputs. */
export const ArtifactMeta = z.object({
  schemaVersion: z.string(),
  runId: Id,
  createdAt: IsoDate,
  toolVersion: z.string(),
  gitCommit: z.string().nullable(),
  configHash: Sha256,
  sourceHash: Sha256,
});
export type ArtifactMeta = z.infer<typeof ArtifactMeta>;

export const SourceRange = z
  .object({ start: z.number().int().positive(), end: z.number().int().positive() })
  .refine((r) => r.end >= r.start, 'range end must not precede start');
export type SourceRange = z.infer<typeof SourceRange>;

export const Location = z.object({
  file: z.string(),
  range: SourceRange.optional(),
});
export type Location = z.infer<typeof Location>;
