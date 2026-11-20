import { describe, expect, it } from 'vitest';
import { lostResults } from '../src/apply.js';

describe('lostResults', () => {
  it('lists results that were decided before the patch and are undecided after it', () => {
    const before = {
      'C-a': 'proven_within_model',
      'C-b': 'counterexample_found',
      'C-c': 'unknown',
      'PBT-d': 'passed',
      'C-e': 'proven_within_model',
    };
    const after = {
      'C-a': 'timeout',
      'C-b': 'counterexample_found',
      'C-c': 'timeout',
      'PBT-d': 'error',
      // A claim that is not made again (for example about a mutant the new test kills) is not a loss.
    };
    expect(lostResults(before, after)).toEqual([
      'C-a: proven_within_model -> timeout',
      'PBT-d: passed -> error',
    ]);
  });

  it('is empty when nothing decided became undecided', () => {
    expect(lostResults({ 'C-a': 'unknown' }, { 'C-a': 'unknown' })).toEqual([]);
    expect(lostResults({ 'C-a': 'timeout' }, { 'C-a': 'proven_within_model' })).toEqual([]);
  });
});
