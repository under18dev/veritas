import { TestCase, VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { copyFixture } from './helpers.js';

describe('discount-boundary fixture', () => {
  it('maps shipping boundary calls to directly asserted edges', () => {
    const inventory = inventoryTests({
      root: copyFixture('discount-boundary'),
      config: VeritasConfig.parse({}),
    });
    const shipping = inventory.tests.filter((test) => test.file.endsWith('shipping-boundary.test.ts'));

    expect(shipping).toHaveLength(2);
    expect(shipping.flatMap((test) => test.targetCalls.map((call) => call.args))).toEqual([
      ['4999'],
      ['5000'],
    ]);
    expect(shipping.every((test) => test.targetCalls.every((call) => call.asserted))).toBe(true);
    expect(
      inventory.edges
        .filter((edge) => shipping.some((test) => test.id === edge.testId))
        .flatMap((edge) => edge.evidence.map((evidence) => evidence.kind)),
    ).toEqual(['static_call', 'direct_assertion', 'static_call', 'direct_assertion']);
  });

  it('keeps the tautological test disconnected', () => {
    const inventory = inventoryTests({
      root: copyFixture('discount-boundary'),
      config: VeritasConfig.parse({}),
    });
    const tautological = inventory.tests.find((test) => test.file.endsWith('tautological.test.ts'));

    expect(tautological?.suspicions).toContain('tautological_assertion');
    expect(inventory.edges.filter((edge) => edge.testId === tautological?.id)).toEqual([]);
  });

  it('validates the inventory and every test against the core schema', () => {
    const inventory = inventoryTests({
      root: copyFixture('discount-boundary'),
      config: VeritasConfig.parse({}),
    });

    for (const test of inventory.tests) expect(() => TestCase.parse(test)).not.toThrow();
  });
});
