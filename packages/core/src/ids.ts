import { hashValue } from './hash.js';

/**
 * Stable, content-derived IDs: the same logical entity gets the same ID across runs,
 * so findings and properties can be matched between runs.
 */
export function stableId(prefix: string, identity: unknown, length = 12): string {
  return `${prefix}-${hashValue(identity).slice(0, length)}`;
}

/** Run IDs are time-ordered and unique per invocation. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  return `run-${stamp}-${rand}`;
}
