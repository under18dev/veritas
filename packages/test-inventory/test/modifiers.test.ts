import { VeritasConfig } from '@under18dev/veritas-core';
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
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
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
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const testCase = inventory.tests.at(0);

    if (!testCase) throw new Error('missing generated test');

    expect(testCase.suitePath).toEqual(['generated']);
    expect(testCase.modifiers).toContain('each');
  });
});
