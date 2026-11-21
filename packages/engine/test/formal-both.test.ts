import { describe, expect, it } from 'vitest';
import { leanSkipReason } from '../src/run.js';

describe('the both formal backend', () => {
  it('tries Lean only on what Z3 proved, and only inside the Lean subset', () => {
    expect(leanSkipReason('proven_within_model', true)).toBeNull();
    expect(leanSkipReason('proven_within_model', false)).toBe('skipped, outside the Lean subset');
    // A refuted or mismatched model is never given a Lean proof next to it.
    for (const status of [
      'counterexample_found',
      'semantic_mismatch',
      'unknown',
      'timeout',
      'unsupported',
      'error',
    ] as const)
      expect(leanSkipReason(status, true)).toBe(`skipped, Z3 result is ${status}`);
  });
});
