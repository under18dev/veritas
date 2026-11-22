import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportsFunction, holdsForAllProperty, proveProperty, translateFunction } from '../src/index.js';

const SOURCE = `export interface Stage {
  undecided: number;
  testsRan: number;
  failed: boolean;
}
function status(s: Stage): number {
  if (s.failed) return 2;
  if (s.undecided > 0) return 0;
  return 1;
}
function guarded(s: Stage): number {
  if (s.testsRan <= 0) return 0;
  return status(s);
}
export function invariant_unguarded(s: Stage): boolean {
  return status(s) !== 1 || s.testsRan >= 1;
}
export function invariant_guarded(s: Stage): boolean {
  return guarded(s) !== 1 || s.testsRan >= 1;
}
export function count(s: Stage): number {
  return s.testsRan;
}
`;

const DOMAIN = { min: '-100', max: '100' };

function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-holds-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'src/stage.ts'), SOURCE);

  return root;
}

function translated(exportName: string) {
  const result = translateFunction({ file: 'src/stage.ts', source: SOURCE, exportName, domain: DOMAIN });

  if (result.status !== 'translated') throw new Error(JSON.stringify(result));

  return result;
}

function prove(root: string, exportName: string) {
  return proveProperty({
    kind: 'conformance',
    propertyId: `D-${exportName}`,
    ir: holdsForAllProperty(translated(exportName), { min: '0', max: '100' }),
    root,
    bindings: [{ modelName: exportName, modulePath: path.join(root, 'src/stage.ts'), exportName }],
    timeoutMs: 10_000,
  });
}

describe('holdsForAllProperty', () => {
  it('states that the function returns true for every input, over the given domain', () => {
    const ir = holdsForAllProperty(translated('invariant_guarded'), { min: '0', max: '7' });
    expect(ir.params).toEqual([
      { name: 's__undecided', sort: 'int', domain: { min: '0', max: '7' } },
      { name: 's__testsRan', sort: 'int', domain: { min: '0', max: '7' } },
      { name: 's__failed', sort: 'bool' },
    ]);
    expect(ir.body).toEqual({
      kind: 'binary',
      op: '==',
      left: {
        kind: 'call',
        fn: 'invariant_guarded',
        args: ir.params.map((p) => ({ kind: 'var', name: p.name })),
      },
      right: { kind: 'bool', value: true },
    });
    expect(ir.functions.map((f) => f.name).sort()).toEqual(
      ['invariant_guarded', 'invariant_guarded__guarded', 'invariant_guarded__status'].sort(),
    );
  });

  it('refuses a function that does not return a boolean', () => {
    expect(() => holdsForAllProperty(translated('count'))).toThrow(/does not return a boolean/);
  });

  it('is proven with Z3 when it holds and refuted, with a replayed counterexample, when it does not', async () => {
    const root = project();
    const proven = await prove(root, 'invariant_guarded');
    expect(proven.claim.status).toBe('proven_within_model');
    expect(proven.claim.semanticValidation).toBe('confirmed');
    const refuted = await prove(root, 'invariant_unguarded');
    expect(refuted.claim.status).toBe('counterexample_found');
    expect(refuted.claim.semanticValidation).toBe('confirmed');
    // The record is reassembled: a stage that succeeded without a test.
    expect(refuted.claim.counterexample).toMatchObject({
      s: { undecided: expect.any(String), testsRan: '0' },
    });
    expect(refuted.replay.some((r) => r.purpose === 'counterexample' && r.agrees === true)).toBe(true);
  }, 60_000);
});

describe('exportsFunction', () => {
  it('finds exported declarations, constants and export lists, not local functions', () => {
    const source = `export function a(): boolean { return true; }
export const b = (): boolean => true;
function c(): boolean { return true; }
function d(): boolean { return true; }
const e = (): boolean => true;
export { d, e as renamed };
export type { T } from './t.js';
`;
    expect(exportsFunction('m.ts', source, 'a')).toBe(true);
    expect(exportsFunction('m.ts', source, 'b')).toBe(true);
    expect(exportsFunction('m.ts', source, 'c')).toBe(false);
    expect(exportsFunction('m.ts', source, 'd')).toBe(true);
    // Exported under another name: importing `e` would not find it.
    expect(exportsFunction('m.ts', source, 'e')).toBe(false);
    expect(exportsFunction('m.ts', source, 'missing')).toBe(false);
  });
});
