import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeCode } from '@under18dev/veritas-code-intelligence';
import {
  type Mutant,
  type Property,
  type TestCase,
  type TestPropertyEdge,
  VeritasConfig,
} from '@under18dev/veritas-core';
import { inventoryTests } from '@under18dev/veritas-test-inventory';
import { describe, expect, it } from 'vitest';
import { linkMutants, linkTests } from '../src/index.js';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'veritas-link-'));
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), contents);
  }
  return root;
}

const DISCOUNT = 'src/pricing.ts#discountAmount';

const property = {
  id: 'P-discount',
  status: 'accepted',
  origin: 'normative',
  targetSymbols: [DISCOUNT],
  predicate: { param: 'total', operator: '>=', value: '1000', consequence: 'discount of 100' },
} as unknown as Property;

describe('linkTests', () => {
  it('never links a test to a property because its name mentions the target function', () => {
    const root = project({
      'src/pricing.ts': [
        'export function discountAmount(total: number): number {',
        '  return total > 1000 ? 100 : 0;',
        '}',
        'export function shippingFee(total: number): number {',
        '  return total >= 5000 ? 0 : 500;',
        '}',
        '',
      ].join('\n'),
      'test/pricing.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { discountAmount, shippingFee } from '../src/pricing.js';",
        '',
        "it('discountAmount gives 100 off at 1000', () => {",
        '  expect(shippingFee(1000)).toBe(500);',
        '});',
        '',
        "it('discountAmount is correct', () => {",
        '  expect(1).toBe(1);',
        '});',
        '',
        "it('charges a discount on large orders', () => {",
        '  expect(discountAmount(2000)).toBe(100);',
        '});',
        '',
      ].join('\n'),
    });
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });
    const byName = (name: string) => inventory.tests.find((t) => t.name === name);
    const nameOnly = [byName('discountAmount gives 100 off at 1000'), byName('discountAmount is correct')];
    const caller = byName('charges a discount on large orders');
    expect(nameOnly.every((t) => t !== undefined)).toBe(true);
    expect(caller).toBeDefined();

    // Even a mutant in the target that lists the name-only tests as killers cannot create an edge from nothing.
    const mutant = {
      id: 'M-1',
      status: 'killed',
      killedBy: nameOnly.map((t) => t?.id),
      coveredBy: nameOnly.map((t) => t?.id),
      propertyIds: [property.id],
    } as unknown as Mutant;
    const linked = linkTests(inventory.tests, inventory.edges, [property], [mutant]);

    for (const t of nameOnly)
      expect(linked.filter((e) => e.testId === t?.id && e.propertyId === property.id)).toEqual([]);
    expect(linked.filter((e) => nameOnly.some((t) => t?.id === e.testId) && e.symbol === DISCOUNT)).toEqual(
      [],
    );

    // Control: the test that really calls and asserts on discountAmount is linked, with code evidence.
    const edge = linked.find((e) => e.testId === caller?.id && e.propertyId === property.id);
    expect(edge?.evidence.map((x) => x.kind)).toEqual(['static_call', 'direct_assertion']);
  });

  it('does not attach a property to an edge backed only by name similarity or an LLM guess', () => {
    const tests = ['T-name', 'T-llm'].map(
      (id) => ({ id, name: 'discountAmount works', file: 'test/a.test.ts' }) as unknown as TestCase,
    );
    const edges: TestPropertyEdge[] = [
      {
        id: 'E-name',
        testId: 'T-name',
        symbol: DISCOUNT,
        propertyId: null,
        evidence: [{ kind: 'name_similarity', detail: 'name mentions discountAmount', artifactIds: [] }],
      },
      {
        id: 'E-llm',
        testId: 'T-llm',
        symbol: DISCOUNT,
        propertyId: null,
        evidence: [
          { kind: 'name_similarity', detail: 'name mentions discountAmount', artifactIds: [] },
          { kind: 'llm_hypothesis', detail: 'the model guessed this test covers the rule', artifactIds: [] },
        ],
      },
    ];
    const killed = {
      id: 'M-1',
      status: 'killed',
      killedBy: ['T-name', 'T-llm'],
      coveredBy: ['T-name', 'T-llm'],
      propertyIds: [property.id],
    } as unknown as Mutant;
    const linked = linkTests(tests, edges, [property], [killed]);
    expect(linked.filter((e) => e.propertyId !== null)).toEqual([]);
    expect(linked.map((e) => e.testId).sort()).toEqual(['T-llm', 'T-name']);
  });
});

describe('linkMutants', () => {
  it('relates a mutant to a property only when it uses the parameter as an identifier', () => {
    const root = project({
      'src/area.ts': [
        'export function area(a: number, cache: number): number {',
        '  const scaled = cache * 2;',
        '  return a * a + scaled;',
        '}',
        '',
      ].join('\n'),
    });
    const config = VeritasConfig.parse({});
    const { functions } = analyzeCode({ root, config });
    const areaProperty = {
      id: 'P-area',
      status: 'accepted',
      origin: 'normative',
      targetSymbols: ['src/area.ts#area'],
      predicate: { param: 'a', operator: '>=', value: '0', consequence: 'non-negative' },
    } as unknown as Property;
    const mutant = (id: string, line: number, original: string): Mutant =>
      ({
        id,
        location: { file: 'src/area.ts', range: { start: line, end: line } },
        original,
        replacement: '0',
        status: 'survived',
        propertyIds: [],
        relevance: 'unknown',
      }) as unknown as Mutant;
    const [unrelated, related] = linkMutants(
      [mutant('M-cache', 2, 'cache * 2'), mutant('M-a', 3, 'a * a')],
      [areaProperty],
      functions,
    );
    expect(unrelated?.relevance).toBe('unrelated');
    expect(unrelated?.propertyIds).toEqual([]);
    expect(related?.relevance).toBe('spec_relevant');
    expect(related?.propertyIds).toEqual(['P-area']);
  });
});
