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
      empty: false,
    });
  });

  it('is partial when a mutant is pending or has an unrecognized status', () => {
    expect(
      mutationStageStatus({ status: 'succeeded', mutants: [mutant('killed'), mutant('pending')] }).status,
    ).toBe('partial');
    expect(mutationStageStatus({ status: 'succeeded', mutants: [mutant('unknown')] })).toEqual({
      status: 'partial',
      undecided: 1,
      empty: false,
    });
  });

  it('keeps a failed or unsupported run as it is', () => {
    expect(mutationStageStatus({ status: 'failed', mutants: [] }).status).toBe('failed');
    expect(mutationStageStatus({ status: 'unsupported', mutants: [mutant('pending')] }).status).toBe(
      'unsupported',
    );
  });

  it('accepts pending mutants outside the change of an incremental run, but never unknown ones', () => {
    const mutants = [mutant('killed'), mutant('pending')];
    expect(mutationStageStatus({ status: 'succeeded', mutants }, { incremental: true }).status).toBe(
      'succeeded',
    );
    expect(
      mutationStageStatus(
        { status: 'succeeded', mutants: [...mutants, mutant('unknown')] },
        { incremental: true },
      ),
    ).toEqual({ status: 'partial', undecided: 1, empty: false });
  });

  it('is partial when a complete run has no mutant at all, except in an incremental run', () => {
    expect(mutationStageStatus({ status: 'succeeded', mutants: [] })).toEqual({
      status: 'partial',
      undecided: 0,
      empty: true,
    });
    expect(mutationStageStatus({ status: 'succeeded', mutants: [] }, { incremental: true }).status).toBe(
      'succeeded',
    );
  });
});
