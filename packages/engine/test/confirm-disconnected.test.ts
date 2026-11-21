import { type Mutant, type TestCase, VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { mergeConfirmation, selectConfirmation } from '../src/confirm.js';

const asserted = { symbol: 'f', args: [], asserted: true, location: { file: 'x' } };
const test = (id: string, file: string, overrides: Partial<TestCase> = {}) =>
  ({
    id,
    file,
    suspicions: [],
    targetCalls: [],
    modifiers: [],
    calledSymbols: [],
    ...overrides,
  }) as unknown as TestCase;
const mutant = (id: string, status: Mutant['status'], killedBy: string[], coveredBy: string[]) =>
  ({ id, status, killedBy, coveredBy }) as unknown as Mutant;

const inventory = {
  files: [
    { path: 'src/a.test.ts', hash: 'a', dependencies: ['src/a.ts', 'src/shared.ts', 'test/helpers.ts'] },
    { path: 'src/b.test.ts', hash: 'b', dependencies: ['src/b.ts'] },
    { path: 'src/c.test.ts', hash: 'c', dependencies: ['test/helpers.ts'] },
  ].map((f) => ({ unseenReach: false, ...f })),
  tests: [
    test('T-unlinked', 'src/a.test.ts'),
    test('T-linked', 'src/a.test.ts', { targetCalls: [asserted] as TestCase['targetCalls'] }),
    test('T-constant', 'src/a.test.ts', { suspicions: ['tautological_assertion'] }),
    test('T-opaque', 'src/a.test.ts', { suspicions: ['opaque_call'] }),
    test('T-skipped', 'src/a.test.ts', { modifiers: ['skip'] }),
    test('T-expected-failure', 'src/a.test.ts', { modifiers: ['expected_failure'] }),
    test('T-killer', 'src/b.test.ts'),
    test('T-no-source', 'src/c.test.ts'),
  ],
};

describe('selectConfirmation', () => {
  const config = VeritasConfig.parse({});

  it('selects the unlinked tests the main run credited with no kill, with the sources their files import', () => {
    const selection = selectConfirmation(inventory, [mutant('M-1', 'killed', ['T-killer'], [])], config);
    // A constant assertion, an opaque call, a linked, skipped or expected-failure test, a kill or no project source:
    // not selected.
    expect(selection).toEqual({
      testIds: ['T-unlinked'],
      testFiles: ['src/a.test.ts'],
      sourceFiles: ['src/a.ts', 'src/shared.ts'],
    });
  });

  it('mutates only the files a checked test calls into, when static analysis sees it call any', () => {
    const calling = {
      ...inventory,
      tests: [test('T-calls', 'src/a.test.ts', { calledSymbols: ['src/a.ts#run', 'node_modules/x.js#y'] })],
    };
    expect(selectConfirmation(calling, [], config).sourceFiles).toEqual(['src/a.ts']);
  });

  it('keeps only sources in the scope', () => {
    expect(selectConfirmation(inventory, [], config, ['src/shared.ts']).sourceFiles).toEqual([
      'src/shared.ts',
    ]);
    expect(selectConfirmation(inventory, [], config, ['lib/**']).testIds).toEqual([]);
  });
});

describe('mergeConfirmation', () => {
  it('takes over kills and runs by the checked tests only', () => {
    const main = [
      mutant('M-killed', 'killed', ['T-other'], ['T-other', 'T-a']),
      mutant('M-survived', 'survived', [], ['T-a']),
      mutant('M-pending', 'pending', [], []),
      mutant('M-timeout', 'timeout', [], ['T-a']),
    ];
    const check = [
      mutant('M-killed', 'killed', ['T-a', 'T-b'], ['T-a', 'T-b']),
      mutant('M-survived', 'survived', [], ['T-a']),
      mutant('M-pending', 'killed', ['T-b'], ['T-b']),
      mutant('M-timeout', 'killed', ['T-a'], ['T-a']),
      mutant('M-unknown-to-main', 'killed', ['T-a'], ['T-a']),
    ];
    const merged = mergeConfirmation(main, check, ['T-a']);
    const byId = new Map(merged.mutants.map((m) => [m.id, m]));

    // T-b is not a checked test: its kill of an already killed mutant is not added.
    expect(byId.get('M-killed')?.killedBy).toEqual(['T-other', 'T-a']);
    expect(byId.get('M-survived')).toEqual(main[1]);
    // An undecided mutant the check killed is killed, whoever killed it.
    expect(byId.get('M-pending')).toMatchObject({ status: 'killed', killedBy: ['T-b'] });
    expect(byId.get('M-pending')?.statusReason).toMatch(/it was pending in the main run/);
    // A timed-out mutant keeps the main run's verdict.
    expect(byId.get('M-timeout')).toEqual(main[3]);
    expect(merged.mutants).toHaveLength(4);
    expect(merged.killedBy).toEqual(['T-a']);
    expect(merged.ranBy).toEqual({ 'T-a': ['M-killed', 'M-survived'] });
    expect(merged.inconsistent).toEqual([]);
    expect(merged.adopted).toEqual(['M-pending']);
  });

  it('reports a mutant the main run found covered by no test, but the check killed, instead of merging it', () => {
    const main = [mutant('M-1', 'no_coverage', [], [])];
    const merged = mergeConfirmation(main, [mutant('M-1', 'killed', ['T-a'], ['T-a'])], ['T-a']);
    expect(merged.mutants).toEqual(main);
    expect(merged.inconsistent).toEqual(['M-1']);
    expect(merged.adopted).toEqual([]);
  });

  it('reports a main-run survivor a checked test killed instead of merging it', () => {
    const main = [mutant('M-1', 'survived', [], ['T-a'])];
    const merged = mergeConfirmation(main, [mutant('M-1', 'killed', ['T-a'], ['T-a'])], ['T-a']);
    expect(merged.mutants).toEqual(main);
    expect(merged.inconsistent).toEqual(['M-1']);
    expect(merged.killedBy).toEqual([]);
  });

  it('never turns a survivor of the check into anything but a record that the test ran it', () => {
    const main = [mutant('M-1', 'pending', [], []), mutant('M-2', 'killed', ['T-x'], ['T-x'])];
    const merged = mergeConfirmation(
      main,
      [mutant('M-1', 'survived', [], ['T-a']), mutant('M-2', 'survived', [], ['T-a'])],
      ['T-a'],
    );
    expect(merged.mutants[0]).toEqual(main[0]);
    expect(merged.mutants[1]).toMatchObject({
      status: 'killed',
      killedBy: ['T-x'],
      coveredBy: ['T-x', 'T-a'],
    });
    expect(merged.ranBy).toEqual({ 'T-a': ['M-2'] });
  });
});
