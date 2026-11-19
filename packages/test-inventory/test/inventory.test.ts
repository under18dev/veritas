import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VeritasConfig } from '@veritas/core';
import { describe, expect, it } from 'vitest';
import { copyFixture } from '../../../test/acceptance/helpers.js';
import { inventoryTests, testId } from '../src/index.js';

describe('inventoryTests', () => {
  it('discovers project calls, literal arguments, assertions, and edges', () => {
    const root = copyFixture('discount-boundary');
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const weak = inventory.tests.filter((test) => test.file.endsWith('discount-weak.test.ts'));

    expect(weak).toHaveLength(2);
    expect(weak[0]?.calledSymbols).toEqual(['src/pricing.ts#discountAmount']);
    expect(weak[0]?.targetCalls[0]).toMatchObject({
      symbol: 'src/pricing.ts#discountAmount',
      args: ['2000'],
      asserted: true,
    });
    expect(inventory.edges.filter((edge) => edge.symbol === 'src/pricing.ts#discountAmount')).toHaveLength(2);
    expect(inventory.edges[0]?.evidence.map((evidence) => evidence.kind)).toContain('direct_assertion');
  });

  it('reports tautologies and preserves deterministic IDs and hashes', () => {
    const root = copyFixture('discount-boundary');
    const first = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const second = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const tautology = first.tests.find((test) => test.file.endsWith('tautological.test.ts'));

    expect(tautology?.suspicions).toEqual(['tautological_assertion', 'target_not_called']);
    expect(first.tests).toEqual(second.tests);
    expect(first.files).toEqual(second.files);
    expect(testId('test/a.test.ts', [], 'x')).toBe(testId('test\\a.test.ts', [], 'x'));
  });

  it('handles nested suites, each, aliases, mocks, snapshots, and nondeterminism', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'veritas-inventory-'));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'test'));
    writeFileSync(path.join(root, 'src/value.ts'), 'export const value = (input: number) => input;\n');
    writeFileSync(path.join(root, 'src/index.ts'), "export { value } from './value.js';\n");
    writeFileSync(
      path.join(root, 'test/value.test.ts'),
      `
      import { expect, test, vi } from 'vitest';
      import { value as alias } from '../src/index.js';
      vi.mock('../src/index.js');
      test.each([[1]])('row', (input) => {
        const result = alias(input);
        expect(result).toMatchInlineSnapshot();
        Math.random();
        Date.now();
        setTimeout(() => {}, 1);
      });
    `,
    );
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const testCase = inventory.tests[0];

    expect(testCase?.suitePath).toEqual([]);
    expect(testCase?.modifiers).toContain('each');
    expect(testCase?.calledSymbols).toEqual(['src/value.ts#value']);
    expect(testCase?.usesMocks).toBe(true);
    expect(testCase?.usesSnapshots).toBe(true);
    expect(testCase?.nondeterminism).toEqual(expect.arrayContaining(['Math.random', 'Date.now', 'timer']));
    expect(testCase?.suspicions).not.toContain('no_assertion');
  });
});
