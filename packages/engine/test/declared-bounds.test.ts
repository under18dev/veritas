import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashValue, VeritasConfig } from '@under18dev/veritas-core';
import {
  applyMutation,
  detectionProperty,
  holdsForAllProperty,
  translateFunction,
} from '@under18dev/veritas-formal-core';
import { declaredProperties } from '@under18dev/veritas-property-engine';
import { describe, expect, it } from 'vitest';
import { formalBounds, runSourceHash } from '../src/index.js';

describe('runSourceHash', () => {
  it('covers declared target files, and stays the hash of the analyzed files without declarations', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-source-hash-')));
    mkdirSync(path.join(root, 'src'));
    const target = path.join(root, 'src/a.ts');
    writeFileSync(target, 'export function invariant_short(): boolean {\n  return true;\n}\n');
    const files = [{ path: 'src/other.ts', hash: 'x' }];
    expect(runSourceHash(root, VeritasConfig.parse({}), files)).toBe(hashValue(files));
    const declaring = VeritasConfig.parse({
      properties: [
        { id: 'short', kind: 'holds_for_all', target: 'src/a.ts#invariant_short', description: 'short' },
      ],
    });
    const before = runSourceHash(root, declaring, files);
    expect(before).not.toBe(hashValue(files));
    writeFileSync(target, 'export function invariant_short(): boolean {\n  return false;\n}\n');
    expect(runSourceHash(root, declaring, files)).not.toBe(before);
  });
});

const SOURCE = `export function invariant_short(xs: number[]): boolean {
  return xs.length <= 5;
}
`;

const config = VeritasConfig.parse({});
const declare = (domain?: { maxArrayLength?: number; integer?: { min: string; max: string } }) =>
  declaredProperties(
    [
      {
        id: 'short',
        kind: 'holds_for_all',
        target: 'src/a.ts#invariant_short',
        description: 'short arrays',
        ...(domain ? { domain } : {}),
      },
    ],
    { integerDomain: config.formal.integerDomain, maxArrayLength: config.formal.maxArrayLength },
  )[0] as NonNullable<ReturnType<typeof declaredProperties>[number]>;

describe('formalBounds', () => {
  it('uses the bounds of a declaration, and the formal settings otherwise', () => {
    expect(formalBounds(declare({ maxArrayLength: 2, integer: { min: '0', max: '9' } }), config)).toEqual({
      integer: { min: '0', max: '9' },
      maxArrayLength: 2,
    });
    expect(formalBounds(declare(), config)).toEqual({
      integer: config.formal.integerDomain,
      maxArrayLength: 3,
    });
    const discovered = { ...declare(), origin: 'normative' as const, inputDomain: { total: 'integer' } };
    expect(formalBounds(discovered, config)).toEqual({
      integer: config.formal.integerDomain,
      maxArrayLength: 3,
    });
  });

  it('models a mutant with the signature of a declaration bounded below the global array length', () => {
    const property = declare({ maxArrayLength: 2 });
    const bounds = formalBounds(property, config);
    const translate = (source: string, maxArrayLength: number, modelName?: string) => {
      const result = translateFunction({
        file: 'src/a.ts',
        source,
        exportName: 'invariant_short',
        domain: bounds.integer,
        maxArrayLength,
        ...(modelName ? { modelName } : {}),
      });

      if (result.status !== 'translated') throw new Error(JSON.stringify(result));

      return result;
    };
    const ir = holdsForAllProperty(translate(SOURCE, bounds.maxArrayLength), bounds.integer);
    const mutated = applyMutation(SOURCE, { line: 2, column: 20, original: '<=', replacement: '<' });
    const name = 'invariant_short__mutant';
    // With the declaration's bound the pair can be compared; with the global bound it cannot.
    expect(() =>
      detectionProperty(ir, 'invariant_short', translate(mutated, bounds.maxArrayLength, name)),
    ).not.toThrow();
    expect(() =>
      detectionProperty(ir, 'invariant_short', translate(mutated, config.formal.maxArrayLength, name)),
    ).toThrow(/signature/);
  });
});
