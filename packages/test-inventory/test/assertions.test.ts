import { VeritasConfig } from '@veritas/core';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

describe('assertion evidence', () => {
  it('distinguishes no assertions, helper assertions, local consts, and direct assertions', () => {
    const root = tempProject({
      'src/math.ts': 'export function fn(value: number): number { return value + 1; }\n',
      'test/assertions.test.ts': `
        import { expect, test } from 'vitest';
        import { fn } from '../src/math.js';
        function check(value: number) { expect(value).toBe(2); }
        test('no assertion', () => { fn(1); });
        test('helper assertion', () => { check(fn(1)); });
        test('discarded result', () => { fn(1); expect(true).toBe(true); });
        test('local const', () => { const result = fn(1); expect(result).toBe(2); });
        test('direct', () => { expect(fn(1)).toBe(2); });
      `,
    });
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const byName = (name: string) => {
      const test = inventory.tests.find((candidate) => candidate.name === name);
      if (!test) throw new Error(`missing test: ${name}`);
      return test;
    };

    expect(byName('no assertion').suspicions).toContain('no_assertion');
    expect(
      inventory.edges
        .find((edge) => edge.testId === byName('no assertion').id)
        ?.evidence.map((evidence) => evidence.kind),
    ).toEqual(['static_call']);
    expect(byName('helper assertion').suspicions).not.toContain('no_assertion');
    expect(byName('discarded result').targetCalls[0]?.asserted).toBe(false);
    expect(byName('local const').targetCalls[0]?.asserted).toBe(true);
    expect(byName('direct').targetCalls[0]?.asserted).toBe(true);
  });

  it('counts expect.assertions, assert.equal, and snapshot matcher variants', () => {
    const root = tempProject({
      'src/math.ts': 'export function fn(value: number): number { return value; }\n',
      'test/assertions.test.ts': `
        import { assert, expect, test } from 'vitest';
        import { fn } from '../src/math.js';
        test('assertions', () => { expect.assertions(2); assert.equal(fn(1), 1); });
        test('snapshots', () => { expect(fn(1)).toMatchSnapshot(); expect(fn(2)).toMatchFileSnapshot('x'); });
      `,
    });
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });

    expect(inventory.tests.find((test) => test.name === 'assertions')?.assertionCount).toBe(2);
    expect(inventory.tests.find((test) => test.name === 'snapshots')?.assertionCount).toBe(2);
    expect(inventory.tests.find((test) => test.name === 'snapshots')?.usesSnapshots).toBe(true);
  });
});
