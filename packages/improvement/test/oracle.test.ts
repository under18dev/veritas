import { equivalenceProperty, translateFunction } from '@under18dev/veritas-formal-core';
import { describe, expect, it } from 'vitest';
import {
  boundaryValues,
  expectedFromSpec,
  importSpecifier,
  renderTestFile,
  specClauses,
  unifiedDiff,
} from '../src/index.js';
import { AGE_SOURCE, DISCOUNT_SOURCE, DOMAIN, thresholdPropertyOf } from './helpers.js';

const senior = thresholdPropertyOf({
  file: 'src/age.ts',
  source: AGE_SOURCE,
  exportName: 'isSenior',
  param: 'age',
  operator: '>=',
  value: '65',
  whenTrue: true,
  whenFalse: false,
});

const discount = thresholdPropertyOf({
  file: 'src/pricing.ts',
  source: DISCOUNT_SOURCE,
  exportName: 'discountAmount',
  param: 'total',
  operator: '>=',
  value: '1000',
  whenTrue: '100',
  whenFalse: '0',
});

describe('expected values from the specification model', () => {
  it('reads both documented clauses of a threshold property', () => {
    const ir = senior.ir as NonNullable<typeof senior.ir>;
    expect(specClauses(ir)).toHaveLength(2);
    expect(expectedFromSpec(ir, { age: '65' })).toMatchObject({ status: 'expected', value: true });
    expect(expectedFromSpec(ir, { age: '64' })).toMatchObject({ status: 'expected', value: false });
  });

  it('uses the documented value even where the implementation disagrees', () => {
    // The implementation returns 0 at 1000 (`total > 1000`); the documented rule says 100.
    const ir = discount.ir as NonNullable<typeof discount.ir>;
    expect(expectedFromSpec(ir, { total: '1000' })).toMatchObject({ status: 'expected', value: '100' });
  });

  it('never evaluates the implementation model', () => {
    // Replace the implementation body with something that would throw if evaluated.
    const ir = structuredClone(senior.ir as NonNullable<typeof senior.ir>);
    for (const f of ir.functions) f.body = { kind: 'call', fn: 'missing', args: [] };
    expect(expectedFromSpec(ir, { age: '70' })).toMatchObject({ status: 'expected', value: true });
  });

  it('drops clauses the caller marks as assumptions', () => {
    const ir = discount.ir as NonNullable<typeof discount.ir>;
    const result = expectedFromSpec(
      ir,
      { total: '999' },
      {
        exclude: (c) => c.guard?.kind === 'unary' && c.guard.op === 'not',
      },
    );
    expect(result).toMatchObject({ status: 'none' });
    expect(result.status === 'none' && result.reason).toMatch(/assumption/);
  });

  it('rejects inputs outside the model domain, missing parameters and wrong sorts', () => {
    const ir = senior.ir as NonNullable<typeof senior.ir>;
    expect(expectedFromSpec(ir, { age: '10001' })).toMatchObject({ status: 'none' });
    expect(expectedFromSpec(ir, {})).toMatchObject({ status: 'none' });
    expect(expectedFromSpec(ir, { age: true })).toMatchObject({ status: 'none' });
  });

  it('documents nothing for an equivalence property (no specification side)', () => {
    const a = translateFunction({
      file: 'src/age.ts',
      source: AGE_SOURCE,
      exportName: 'isSenior',
      domain: DOMAIN,
      modelName: 'a',
    });
    const b = translateFunction({
      file: 'src/age.ts',
      source: AGE_SOURCE,
      exportName: 'isSenior',
      domain: DOMAIN,
      modelName: 'b',
    });
    if (a.status !== 'translated' || b.status !== 'translated') throw new Error('translation failed');
    const ir = equivalenceProperty(a, b, DOMAIN);
    expect(specClauses(ir)).toEqual([]);
    expect(expectedFromSpec(ir, { age: '1' })).toMatchObject({ status: 'none' });
  });

  it('lists inputs on both sides of each threshold operator', () => {
    expect(boundaryValues('>=', '65')).toEqual(['64', '65']);
    expect(boundaryValues('>', '65')).toEqual(['65', '66']);
    expect(boundaryValues('<=', '100')).toEqual(['100', '101']);
    expect(boundaryValues('<', '120')).toEqual(['119', '120']);
    expect(boundaryValues('==', '0')).toEqual(['-1', '0', '1']);
  });
});

describe('rendering', () => {
  it('renders spec-derived literals and a relative .js import', () => {
    const content = renderTestFile('test/veritas-P-1.test.ts', 'P-1', [
      {
        id: 'PT-1',
        propertyId: 'P-1',
        symbol: 'src/age.ts#isSenior',
        exportName: 'isSenior',
        module: 'src/age.ts',
        params: ['age'],
        input: { age: '65' },
        expected: true,
        origin: 'survived_mutant',
        citations: ['README.md:5'],
        derivation: 'x',
      },
    ]);
    expect(content).toContain('import { isSenior } from "../src/age.js";');
    expect(content).toContain('expect(isSenior(65)).toBe(true);');
    expect(content).not.toMatch(/\.(skip|only|todo)\b/);
    expect(importSpecifier('a.test.ts', 'src/x.mts')).toBe('./src/x.mjs');
  });

  it('refuses an export name that is not an identifier', () => {
    expect(() =>
      renderTestFile('test/a.test.ts', 'P-1', [
        {
          id: 'PT-1',
          propertyId: 'P-1',
          symbol: 's',
          exportName: 'x); process.exit(1); (',
          module: 'src/a.ts',
          params: [],
          input: {},
          expected: true,
          origin: 'boundary',
          citations: [],
          derivation: 'x',
        },
      ]),
    ).toThrow();
  });

  it('produces a unified diff of new files', () => {
    const diff = unifiedDiff([{ operation: 'add', path: 'test/a.test.ts', content: 'a\nb\n' }]);
    expect(diff).toBe('--- /dev/null\n+++ b/test/a.test.ts\n@@ -0,0 +1,2 @@\n+a\n+b');
  });
});
