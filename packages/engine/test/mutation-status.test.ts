import type { Mutant } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  cacheableMutationResult,
  literalInput,
  mutationStageStatus,
  outstandingBudget,
} from '../src/index.js';

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

  it('is partial when source files were left out of the run, even an incremental one', () => {
    const run = { status: 'succeeded' as const, mutants: [mutant('killed')], excludedFiles: ['src/a.ts'] };
    expect(mutationStageStatus(run).status).toBe('partial');
    expect(mutationStageStatus(run, { incremental: true }).status).toBe('partial');
    expect(mutationStageStatus({ ...run, status: 'failed' }).status).toBe('failed');
  });

  it('is partial when the time budget left mutants unrun, even in an incremental run', () => {
    const run = {
      status: 'succeeded' as const,
      mutants: [mutant('killed'), mutant('pending')],
      timeBudgetExhausted: { notRun: 1 },
    };
    expect(mutationStageStatus(run).status).toBe('partial');
    expect(mutationStageStatus(run, { incremental: true }).status).toBe('partial');
    expect(mutationStageStatus({ ...run, status: 'timeout' }).status).toBe('timeout');
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

describe('cacheableMutationResult', () => {
  it('reuses only a succeeded run that left no file out', () => {
    expect(cacheableMutationResult({ status: 'succeeded' })).toBe(true);
    expect(cacheableMutationResult({ status: 'succeeded', excludedFiles: [] })).toBe(true);
    expect(cacheableMutationResult({ status: 'succeeded', excludedFiles: ['src/a.ts'] })).toBe(false);
    expect(cacheableMutationResult({ status: 'failed' })).toBe(false);
  });

  it('does not reuse a run whose time budget ran out', () => {
    expect(
      cacheableMutationResult({ status: 'succeeded', timeBudgetExhausted: { seconds: 45, notRun: 3 } }),
    ).toBe(false);
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
    // An array length is checked against the slots, not against the integer domain of the elements.
    const narrow = (min: string, max: string) =>
      params.map((p) => (p.sort === 'int' ? { ...p, domain: { min, max } } : p));
    expect(
      literalInput(
        narrow('0', '1'),
        ['{"total":"1","vip":true}', '["1","0"]'],
        { min: '0', max: '1' },
        jsParams,
      ),
    ).toMatchObject({ xs__length: '2' });
    expect(
      literalInput(
        narrow('1', '100'),
        ['{"total":"5","vip":true}', '[]'],
        { min: '1', max: '100' },
        jsParams,
      ),
    ).toMatchObject({ xs__length: '0', xs__0: '1', xs__1: '1' });
  });
});

describe('outstandingBudget', () => {
  const budget = { seconds: 60, notRun: 2 };

  it('takes the unrun mutants the confirmation killed off the overrun, so a run they complete is not partial', () => {
    const left = outstandingBudget(budget, ['M-1', 'M-2'], ['M-1', 'M-2']);
    expect(left).toEqual({ seconds: 60, notRun: 0 });
    // Still recorded, so the result is not cached.
    expect(cacheableMutationResult({ status: 'succeeded', timeBudgetExhausted: left })).toBe(false);
    expect(
      mutationStageStatus({
        status: 'succeeded',
        mutants: [mutant('killed'), mutant('killed'), mutant('killed')],
        timeBudgetExhausted: left,
      }).status,
    ).toBe('succeeded');
  });

  it('keeps the mutants still not run, and ignores adopted mutants mutator did not leave unrun', () => {
    // M-3 was relabelled pending by --since or was unknown: it does not reduce the overrun.
    expect(outstandingBudget(budget, ['M-1', 'M-2'], ['M-1', 'M-3'])).toEqual({ seconds: 60, notRun: 1 });
    expect(outstandingBudget(undefined, ['M-1'], ['M-1'])).toBeUndefined();
  });
});
