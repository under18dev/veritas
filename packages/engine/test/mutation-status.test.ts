import type { Mutant } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { literalInput, mutationStageStatus } from '../src/index.js';

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

describe('literalInput', () => {
  const domain = { min: '-100', max: '100' };
  it('expands record and array literals into the flattened model parameters', () => {
    const params = [
      { name: 'order__total', sort: 'int' as const, domain },
      { name: 'order__vip', sort: 'bool' as const },
      { name: 'xs__length', sort: 'int' as const, domain },
      { name: 'xs__0', sort: 'int' as const, domain },
      { name: 'xs__1', sort: 'int' as const, domain },
    ];
    const jsParams = [
      {
        kind: 'record' as const,
        name: 'order',
        fields: [
          { key: 'total', param: 'order__total' },
          { key: 'vip', param: 'order__vip' },
        ],
      },
      { kind: 'array' as const, name: 'xs', length: 'xs__length', elements: ['xs__0', 'xs__1'] },
    ];
    expect(literalInput(params, ['{"total":"10","vip":true}', '["7"]'], domain, jsParams)).toEqual({
      order__total: '10',
      order__vip: true,
      xs__length: '1',
      xs__0: '7',
      xs__1: '-100',
    });
    // Too long for the model, a missing field, or out of the domain: no input.
    expect(literalInput(params, ['{"total":"10","vip":true}', '["1","2","3"]'], domain, jsParams)).toBeNull();
    expect(literalInput(params, ['{"total":"10"}', '[]'], domain, jsParams)).toBeNull();
    expect(literalInput(params, ['{"total":"1000","vip":true}', '[]'], domain, jsParams)).toBeNull();
  });
});
