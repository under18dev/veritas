import type { Mutant } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { mutationStageStatus } from '../src/index.js';

const mutant = (status: Mutant['status']) => ({ status }) as Mutant;

describe('mutationStageStatus', () => {
  it('succeeds only when every mutant has a decided result', () => {
    expect(
      mutationStageStatus({
        status: 'succeeded',
        mutants: [mutant('killed'), mutant('survived'), mutant('timeout')],
      }),
    ).toEqual({
      status: 'succeeded',
      undecided: 0,
    });
  });

  it('is partial when a mutant is pending or has an unrecognized status', () => {
    expect(
      mutationStageStatus({ status: 'succeeded', mutants: [mutant('killed'), mutant('pending')] }).status,
    ).toBe('partial');
    expect(mutationStageStatus({ status: 'succeeded', mutants: [mutant('unknown')] })).toEqual({
      status: 'partial',
      undecided: 1,
    });
  });

  it('keeps a failed or unsupported run as it is', () => {
    expect(mutationStageStatus({ status: 'failed', mutants: [] }).status).toBe('failed');
    expect(mutationStageStatus({ status: 'unsupported', mutants: [mutant('pending')] }).status).toBe(
      'unsupported',
    );
  });
});
