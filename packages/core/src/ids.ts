import { hashValue } from './hash.js';

/**
 * Stable, content-derived IDs: the same logical entity gets the same ID across runs,
 * so findings and properties can be matched between runs.
 */
export function stableId(prefix: string, identity: unknown, length = 12): string {
  return `${prefix}-${hashValue(identity).slice(0, length)}`;
}

let lastStamp = '';
let sequence = 0;

/**
 * Run IDs sort in creation order: millisecond timestamp, then a per-process sequence for runs created in the
 * same millisecond, then a random suffix against collisions between processes.
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  sequence = stamp === lastStamp ? sequence + 1 : 0;
  lastStamp = stamp;
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0');

  return `run-${stamp}-${sequence.toString().padStart(3, '0')}-${rand}`;
}
