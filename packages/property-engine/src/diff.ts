import type { Property } from '@under18dev/veritas-core';
import { contentHash } from './registry.js';

export interface RegistryDiff {
  added: Property[];
  removed: Property[];
  changed: { before: Property; after: Property; fields: string[] }[];
  statusChanged: { id: string; from: Property['status']; to: Property['status'] }[];
}

export function diffRegistries(before: Property[], after: Property[]): RegistryDiff {
  const a = new Map(before.map((p) => [p.id, p]));
  const b = new Map(after.map((p) => [p.id, p]));
  const diff: RegistryDiff = { added: [], removed: [], changed: [], statusChanged: [] };

  for (const [id, p] of b) {
    const old = a.get(id);

    if (!old) {
      diff.added.push(p);
      continue;
    }

    if (contentHash(old) !== contentHash(p)) {
      const fields = (['description', 'predicate', 'targetSymbols', 'sourceIds', 'template'] as const).filter(
        (f) => JSON.stringify(old[f]) !== JSON.stringify(p[f]),
      );
      diff.changed.push({ before: old, after: p, fields });
    }

    if (old.status !== p.status) diff.statusChanged.push({ id, from: old.status, to: p.status });
  }

  for (const [id, p] of a) if (!b.has(id)) diff.removed.push(p);

  return diff;
}
