import { z } from 'zod';
import { Id, Location } from './common.js';
import { MutantStatus } from './status.js';

export const Mutant = z.object({
  id: Id,
  /** Identifier assigned by the mutation backend, kept for replay and `accept`. */
  backendKey: z.string(),
  location: Location,
  operator: z.string(),
  original: z.string(),
  replacement: z.string(),
  status: MutantStatus,
  statusReason: z.string().optional(),
  killedBy: z.array(Id),
  coveredBy: z.array(Id),
  propertyIds: z.array(Id),
  relevance: z.enum(['spec_relevant', 'unrelated', 'unknown']),
  durationMs: z.number().nonnegative().optional(),
  reproduction: z.string(),
});
export type Mutant = z.infer<typeof Mutant>;
