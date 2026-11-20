import { VeritasConfig } from '@under18dev/veritas-core';
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
    // The helper asserts on its parameter, so the project call passed to it is asserted.
    expect(byName('helper assertion').targetCalls[0]?.asserted).toBe(true);
    expect(byName('discarded result').targetCalls[0]?.asserted).toBe(false);
    expect(byName('local const').targetCalls[0]?.asserted).toBe(true);
    expect(byName('direct').targetCalls[0]?.asserted).toBe(true);
  });

  it('marks a call asserted through a helper only when the helper asserts on that parameter', () => {
    const root = tempProject({
      'src/math.ts': 'export function fn(value: number): number { return value + 1; }\n',
      'test/helpers.test.ts': `
        import { expect, test } from 'vitest';
        import { fn } from '../src/math.js';
        function checkSecond(label: string, value: number) { expect(value).toBe(2); }
        const checkArrow = (value: number) => expect(value).toBeGreaterThan(0);
        function ignores(value: number) { expect(1).toBe(1); }
        function same(value: number) { expect(value).toBe(value); }
        test('second parameter', () => { checkSecond('x', fn(1)); });
        test('arrow helper with a local', () => { const r = fn(1); checkArrow(r); });
        test('helper ignores the value', () => { ignores(fn(1)); });
        test('wrong position', () => { checkSecond(String(fn(1)), 0); });
        test('self comparison', () => { same(fn(1)); });
        test('shadowed helper', () => {
          const checkArrow = (value: number) => value;
          checkArrow(fn(1));
        });
      `,
    });
    const tests = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests;
    const asserted = (name: string) => tests.find((t) => t.name === name)?.targetCalls[0]?.asserted;
    expect(asserted('second parameter')).toBe(true);
    expect(asserted('arrow helper with a local')).toBe(true);
    expect(asserted('helper ignores the value')).toBe(false);
    expect(asserted('wrong position')).toBe(false);
    expect(asserted('self comparison')).toBe(false);
    expect(asserted('shadowed helper')).toBe(false);
  });

  it('links assertions on properties of awaited, destructured and derived call results', () => {
    const root = tempProject({
      'src/math.ts': `
        export function fn(value: number) { return { value: value + 1, items: [value] }; }
        export async function fnAsync(value: number) { return { value: value + 1 }; }
        export function list(): number[] { return [1]; }
      `,
      'test/derived.test.ts': `
        import { expect, test } from 'vitest';
        import { fn, fnAsync, list } from '../src/math.js';
        test('property', () => { const a = fn(1); expect(a.value).toBe(2); });
        test('awaited', async () => { const r = await fnAsync(1); expect(r.value).toBe(2); });
        test('object pattern', () => { const { value } = fn(1); expect(value).toBe(2); });
        test('array pattern', () => { const [first] = list(); expect(first).toBe(1); });
        test('derived', () => { const a = fn(1); const v = a.value; expect(v).toBe(2); });
        test('member of call', () => { const v = fn(1).value; expect(v).toBe(2); });
        test('method chain', () => { const a = fn(1); expect(a.items.map((x) => x * 2)).toEqual([2]); });
        test('unrelated local', () => { const a = fn(1); const k = 2; expect(k).toBe(2); });
        test('shadowed', () => {
          const a = fn(1);
          const inner = () => { const a = 2; expect(a).toBe(2); };
          inner();
        });
      `,
    });
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const asserted = (name: string) =>
      inventory.tests.find((test) => test.name === name)?.targetCalls.map((call) => call.asserted);

    for (const name of [
      'property',
      'awaited',
      'object pattern',
      'array pattern',
      'derived',
      'member of call',
      'method chain',
    ])
      expect(asserted(name), name).toEqual([true]);
    expect(asserted('unrelated local')).toEqual([false]);
    expect(asserted('shadowed')).toEqual([false]);
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

  it('records array and object literal arguments as exact JSON, and nothing for other shapes', () => {
    const root = tempProject({
      'src/order.ts':
        'export function fee(order: { total: number; vip: boolean }, xs: readonly number[]): number { return order.total + xs.length; }\n',
      'test/order.test.ts': `
        import { expect, test } from 'vitest';
        import { fee } from '../src/order.js';
        const items = [1];
        test('literals', () => { expect(fee({ total: 9007199254740993, vip: true }, [1, -2])).toBe(0); });
        test('not literal', () => { expect(fee({ total: 1, vip: true, ...{} }, items)).toBe(0); });
      `,
    });
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const args = (name: string) => inventory.tests.find((t) => t.name === name)?.targetCalls[0]?.args;
    expect(args('literals')).toEqual(['{"total":"9007199254740993","vip":true}', '["1","-2"]']);
    expect(args('not literal')).toEqual([null, null]);
  });
});
