import { VeritasConfig } from '@under18dev/veritas-core';
import { jestTestRunner as jest } from '@under18dev/veritas-test-runner-jest';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests, testId } from '../src/index.js';
import { tempProject } from './helpers.js';

const inventory = (root: string, recognition = jest.recognition) =>
  inventoryTests({ recognition, root, config: VeritasConfig.parse({ analysis: { testFramework: 'jest' } }) });

function byName(tests: ReturnType<typeof inventory>['tests'], name: string) {
  const test = tests.find((candidate) => candidate.name === name);

  if (!test) throw new Error(`missing test: ${name}`);

  return test;
}

describe('Jest tests', () => {
  it('recognises the global API without an import', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input + 1;\n',
      'test/globals.test.ts': `
        import { value } from '../src/value.js';
        describe('value', () => {
          beforeEach(() => {});
          it('adds one', () => {
            expect(value(1)).toBe(2);
          });
          test('adds one to zero', () => expect(value(0)).toBe(1));
        });
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => test.name)).toEqual(['adds one', 'adds one to zero']);
    expect(byName(tests, 'adds one')).toMatchObject({
      suitePath: ['value'],
      assertionCount: 1,
      calledSymbols: ['src/value.ts#value'],
      suspicions: [],
    });
    expect(byName(tests, 'adds one').id).toBe(testId('test/globals.test.ts', ['value'], 'adds one'));
  });

  it('recognises the API imported from @jest/globals, under an alias too', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input + 1;\n',
      'test/imported.test.ts': `
        import { describe, expect as check, it as jestIt } from '@jest/globals';
        import { value } from '../src/value.js';
        describe('value', () => {
          jestIt('adds one', () => check(value(1)).toBe(2));
        });
      `,
    });
    const test = byName(inventory(root).tests, 'adds one');

    expect(test.suitePath).toEqual(['value']);
    expect(test.calledSymbols).toEqual(['src/value.ts#value']);
  });

  it('records test.each, describe.each and the x/f shorthands with their modifiers', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/modifiers.test.ts': `
        import { value } from '../src/value.js';
        test.each([[1], [2]])('row %i', (input) => expect(value(input)).toBe(input));
        it.each\`
          input
          \${3}
        \`('template row $input', ({ input }) => expect(value(input)).toBe(input));
        describe.each([[1]])('suite %i', (input) => {
          it('child', () => expect(value(input)).toBe(input));
        });
        xit('skipped', () => expect(value(1)).toBe(1));
        xtest('also skipped', () => expect(value(1)).toBe(1));
        fit('focused', () => expect(value(1)).toBe(1));
        xdescribe('skipped suite', () => it('inner', () => expect(value(1)).toBe(1)));
        fdescribe('focused suite', () => it('focused inner', () => expect(value(1)).toBe(1)));
        it.skip('skipped member', () => expect(value(1)).toBe(1));
        it.todo('later');
        test.concurrent('concurrent', async () => expect(value(1)).toBe(1));
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'row %i').modifiers).toContain('each');
    expect(byName(tests, 'template row $input').modifiers).toContain('each');
    expect(byName(tests, 'child').modifiers).toContain('each');
    expect(byName(tests, 'skipped').modifiers).toContain('skip');
    expect(byName(tests, 'also skipped').modifiers).toContain('skip');
    expect(byName(tests, 'focused').modifiers).toContain('only');
    expect(byName(tests, 'inner').modifiers).toContain('skip');
    expect(byName(tests, 'focused inner').modifiers).toContain('only');
    expect(byName(tests, 'skipped member').modifiers).toContain('skip');
    expect(byName(tests, 'later').modifiers).toContain('todo');
    expect(byName(tests, 'concurrent').modifiers).toContain('concurrent');
  });

  it('records jest.mock, jest.spyOn and jest.fn as mocks with the roles of vi', () => {
    const root = tempProject({
      'src/value.ts': 'export function fn(value: number): number { return value; }\n',
      'src/use.ts':
        "import { fn } from './value.js';\nexport const run = (cb: (n: number) => void) => cb(fn(1));\n",
      'test/module.test.ts': `
        import * as mod from '../src/value.js';
        jest.mock('../src/value.js');
        test('module mocked', () => expect(mod.fn(1)).toBe(1));
      `,
      'test/spy.test.ts': `
        import { jest } from '@jest/globals';
        import * as mod from '../src/value.js';
        test('spied', () => {
          jest.spyOn(mod, 'fn').mockReturnValue(2);
          expect(mod.fn(1)).toBe(2);
        });
      `,
      'test/fn.test.ts': `
        import { run } from '../src/use.js';
        test('callback', () => {
          const cb = jest.fn();
          run(cb);
          expect(cb).toHaveBeenCalledWith(1);
        });
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'module mocked')).toMatchObject({ usesMocks: true });
    expect(byName(tests, 'module mocked').suspicions).toContain('unconditional_mock');
    expect(byName(tests, 'spied')).toMatchObject({ usesMocks: true });
    expect(byName(tests, 'spied').suspicions).toContain('unconditional_mock');
    expect(byName(tests, 'callback')).toMatchObject({ usesMocks: true });
    expect(byName(tests, 'callback').calledSymbols).toContain('src/use.ts#run');
  });

  it('does not take vi for a mock in a Jest project, nor jest in a Vitest one', () => {
    const root = tempProject({
      'src/value.ts': 'export function fn(value: number): number { return value; }\n',
      'test/other.test.ts': `
        import * as mod from '../src/value.js';
        declare const vi: { mock(path: string): void };
        declare const jest: { mock(path: string): void };
        vi.mock('../src/value.js');
        test('not mocked by vi', () => expect(mod.fn(1)).toBe(1));
      `,
    });

    expect(byName(inventory(root).tests, 'not mocked by vi').usesMocks).toBe(false);
    const viRoot = tempProject({
      'src/value.ts': 'export function fn(value: number): number { return value; }\n',
      'test/other.test.ts': `
        import { expect, test } from 'vitest';
        import * as mod from '../src/value.js';
        declare const jest: { mock(path: string): void };
        jest.mock('../src/value.js');
        test('not mocked by jest', () => expect(mod.fn(1)).toBe(1));
      `,
    });

    expect(byName(inventory(viRoot, vitest.recognition).tests, 'not mocked by jest').usesMocks).toBe(false);
  });

  it('counts node:assert and expect.assertions as assertions and flags a tautology', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/assert.test.ts': `
        import assert from 'node:assert';
        import { value } from '../src/value.js';
        test('asserts with node:assert', () => {
          assert.strictEqual(value(1), 1);
        });
        test('counts assertions', () => {
          expect.assertions(1);
          expect(value(1)).toBe(1);
        });
        test('pricing works', () => {
          expect(true).toBe(true);
        });
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'asserts with node:assert').assertionCount).toBeGreaterThan(0);
    expect(byName(tests, 'asserts with node:assert').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'counts assertions').assertionCount).toBeGreaterThan(0);
    expect(byName(tests, 'pricing works').suspicions).toContain('tautological_assertion');
  });
});
