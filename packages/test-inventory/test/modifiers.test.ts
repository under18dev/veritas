import { VeritasConfig } from '@under18dev/veritas-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests, testId } from '../src/index.js';
import { tempProject } from './helpers.js';

describe('Vitest registration modifiers', () => {
  it('records modifiers, propagates describe.skip, and preserves nested suite paths', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/modifiers.test.ts': `
        import { describe, expect, it, test } from 'vitest';
        import { value } from '../src/value.js';
        it.skip('skipped', () => expect(value(1)).toBe(1));
        test.only('focused', () => expect(value(1)).toBe(1));
        test.todo('todo');
        test.concurrent('concurrent', () => expect(value(1)).toBe(1));
        describe.skip('outer', () => describe('inner', () => it('child', () => expect(value(1)).toBe(1))));
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const byName = (name: string) => {
      const test = inventory.tests.find((candidate) => candidate.name === name);

      if (!test) throw new Error(`missing test: ${name}`);

      return test;
    };

    expect(byName('skipped').modifiers).toContain('skip');
    expect(byName('focused').modifiers).toContain('only');
    expect(byName('todo').modifiers).toContain('todo');
    expect(byName('concurrent').modifiers).toContain('concurrent');
    expect(byName('child').modifiers).toContain('skip');
    expect(byName('child').suitePath).toEqual(['outer', 'inner']);
    expect(byName('child').id).toBe(testId('test/modifiers.test.ts', ['outer', 'inner'], 'child'));
  });

  it('records describe.each as a suite modifier and test.each as a test modifier', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/each.test.ts': `
        import { describe, expect, test } from 'vitest';
        import { value } from '../src/value.js';
        describe.each([[1]])('generated', (input) => {
          test.each([[input]])('row', ([item]) => expect(value(item)).toBe(item));
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const testCase = inventory.tests.at(0);

    if (!testCase) throw new Error('missing generated test');

    expect(testCase.suitePath).toEqual(['generated']);
    expect(testCase.modifiers).toContain('each');
  });

  it('registers the test of skipIf, runIf and for, not the call that makes the registration', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/conditional.test.ts': `
        import { describe, expect, test } from 'vitest';
        import { value } from '../src/value.js';
        test.skipIf(!('File' in globalThis))('conditional', () => { expect(value(1)).toBe(1); });
        describe.runIf(true)('suite', () => {
          test.for([1, 2])('row %i', (n) => { expect(value(n)).toBe(n); });
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.suitePath, t.modifiers])).toEqual([
      ['conditional', [], []],
      ['row %i', ['suite'], ['each']],
    ]);
    expect(inventory.tests.every((t) => t.targetCalls.some((call) => call.asserted))).toBe(true);
  });

  it('records it.fails as expected to fail', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/fails.test.ts': `
        import { expect, it } from 'vitest';
        import { value } from '../src/value.js';
        it.fails('inverted', () => expect(value(1)).toBe(2));
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests[0]?.modifiers).toEqual(['expected_failure']);
  });

  it('registers tests and suites of a tagged template table', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/table.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { value } from '../src/value.js';
        describe.each\`
          input
          \${1}
        \`('suite $input', ({ input }) => {
          it.each\`
            item
            \${2}
          \`('row $item', ({ item }) => expect(value(item + input)).toBe(item + input));
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.suitePath, t.modifiers])).toEqual([
      ['row $item', ['suite $input'], ['each']],
    ]);
  });
});

describe('full names static analysis cannot read', () => {
  it('records why a test runs under a name other than its suite path and title', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/names.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { value } from '../src/value.js';
        it.each([[4999]])('fee for %s', (total) => { value(total); expect(true).toBe(true); });
        for (const [t, f] of [[5000, 5000]]) it(\`fee for \${t}\`, () => { expect(value(t)).toBe(f); });
        for (const y of [1]) describe(\`dyn \${y}\`, () => {
          describe('inner', () => it('works', () => expect(value(y)).toBe(y)));
        });
        function shared() { it('shared', () => expect(value(1)).toBe(1)); }
        describe('plain', () => { it('exact', () => expect(value(1)).toBe(1)); shared(); });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.suitePath, t.inexactName])).toEqual([
      ['fee for %s', [], undefined],
      ['<dynamic test>', [], 'dynamic_title'],
      ['works', ['inner'], 'dynamic_suite'],
      ['shared', [], 'registered_in_function'],
      ['exact', ['plain'], undefined],
    ]);
    // Test ids stay as they were: the suite title that is not a literal is still left out of the suite path.
    expect(inventory.tests[2]?.id).toBe(testId('test/names.test.ts', ['inner'], 'works'));
    // `shared()` in the describe callback is a call that registers tests.
    expect(inventory.files.find((f) => f.path === 'test/names.test.ts')?.inexactNames).toBe(
      'registered_by_call',
    );
  });

  it('marks a file that calls a function which may register tests where tests are registered', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/shared-suite.ts': `
        import { expect, it } from 'vitest';
        import { value } from '../src/value.js';
        export function sharedSuite() { it('is shared', () => expect(value(1)).toBe(1)); }
        export const helpers = { run: sharedSuite };
      `,
      'test/top.test.ts': `
        import { it, vi } from 'vitest';
        import { sharedSuite } from './shared-suite.js';
        vi.mock('../src/value.js');
        it('own', () => {});
        sharedSuite();
      `,
      'test/nested.test.ts': `
        import { describe, it } from 'vitest';
        import { helpers } from './shared-suite.js';
        describe('outer', () => { if (true) { helpers.run(); } });
      `,
      'test/passed.test.ts': `
        import { describe } from 'vitest';
        import { sharedSuite } from './shared-suite.js';
        describe('outer', sharedSuite);
      `,
      'test/clean.test.ts': `
        import { beforeEach, describe, expect, it } from 'vitest';
        import { value } from '../src/value.js';
        const app = { get: (_path: string) => {} };
        app.get('/x');
        describe('suite', () => {
          beforeEach(() => { value(1); });
          it('works', () => { value(2); expect(1).toBe(1); });
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const marked = (file: string) => inventory.files.find((f) => f.path === file)?.inexactNames;

    expect(marked('test/top.test.ts')).toBe('registered_by_call');
    expect(marked('test/nested.test.ts')).toBe('registered_by_call');
    expect(marked('test/passed.test.ts')).toBe('registered_by_call');
    expect(marked('test/clean.test.ts')).toBeUndefined();
  });

  it('records tests registered on a condition', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/conditional.test.ts': `
        import { describe, expect, it, test } from 'vitest';
        import { value } from '../src/value.js';
        it('always', () => expect(value(1)).toBe(1));
        if (process.env.CI) it('in ci', () => expect(value(1)).toBe(1));
        test.skipIf(true)('skip if', () => expect(value(1)).toBe(1));
        describe.runIf(true)('run if', () => { it('inside', () => expect(value(1)).toBe(1)); });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.conditional])).toEqual([
      ['always', undefined],
      ['in ci', true],
      ['skip if', true],
      ['inside', true],
    ]);
  });
});
