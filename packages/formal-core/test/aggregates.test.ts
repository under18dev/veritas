import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FormalClaim, type PropertyIR } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  equivalenceProperty,
  outOfBoundsProperty,
  proveProperty,
  shapeInput,
  type TranslationResult,
  thresholdProperty,
  translateFunction,
} from '../src/index.js';

const DOMAIN = { min: '-10000', max: '10000' };
const SOURCE = `export interface Order {
  readonly total: number;
  vip: boolean;
}
export function discount(order: Order): number {
  if (order.total > 1000) return 100;
  return order.vip ? 50 : 0;
}
export function fixedDiscount(order: { total: number; vip: boolean }): number {
  if (order.total >= 1000) return 100;
  return order.vip ? 50 : 0;
}
export function first(xs: readonly number[]): number {
  return xs.length > 0 ? xs[0] : 0;
}
export function sumTwo(xs: Array<number>): number {
  if (xs.length >= 2) return xs[0] + xs[1];
  return xs.length === 1 ? xs[0] : 0;
}
export function unsafeFirst(xs: number[]): number {
  return xs[0] > 5 ? 1 : 0;
}
`;

function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-aggregates-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'src/order.ts'), SOURCE);

  return root;
}

function translate(exportName: string, source = SOURCE, maxArrayLength?: number) {
  return translateFunction({
    file: 'src/order.ts',
    source,
    exportName,
    domain: DOMAIN,
    ...(maxArrayLength !== undefined ? { maxArrayLength } : {}),
  });
}

function translated(result: TranslationResult) {
  if (result.status !== 'translated') throw new Error(`expected translation, got ${JSON.stringify(result)}`);

  return result;
}

const call = (fn: string, params: { name: string }[]) => ({
  kind: 'call' as const,
  fn,
  args: params.map((p) => ({ kind: 'var' as const, name: p.name })),
});

function prove(root: string, ir: PropertyIR, exportName: string) {
  return proveProperty({
    kind: 'conformance',
    propertyId: 'P-agg',
    ir,
    root,
    bindings: [{ modelName: exportName, modulePath: path.join(root, 'src/order.ts'), exportName }],
    timeoutMs: 10_000,
  });
}

describe('records and arrays in the formal subset', () => {
  it('flattens record fields and arrays into scalar parameters with their JavaScript shape', () => {
    const order = translated(translate('discount'));
    expect(order.params).toEqual([
      { name: 'order__total', sort: 'int', domain: DOMAIN },
      { name: 'order__vip', sort: 'bool' },
    ]);
    expect(order.model.jsParams).toEqual([
      {
        kind: 'record',
        name: 'order',
        fields: [
          { key: 'total', param: 'order__total' },
          { key: 'vip', param: 'order__vip' },
        ],
      },
    ]);
    const xs = translated(translate('first', SOURCE, 2));
    expect(xs.params.map((p) => [p.name, p.sort === 'int' ? p.domain : null])).toEqual([
      ['xs__length', { min: '0', max: '2' }],
      ['xs__0', DOMAIN],
      ['xs__1', DOMAIN],
    ]);
  });

  it('rejects everything else on records and arrays with a precise reason', () => {
    const cases: [string, RegExp][] = [
      [
        'export function f(o: { a: number }): number { return g({ ...o }); }\nfunction g(o: { a: number }): number { return o.a; }',
        /spread properties are not supported/,
      ],
      [
        'export function f(xs: number[]): number { return xs[xs.length - 1]; }',
        /outside the supported subset/,
      ],
      [
        'export function f(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }',
        /outside the supported subset/,
      ],
      ['export function f(o: { a?: number }): number { return 1; }', /optional property/],
      [
        'export function f(o: { a: string | null }): number { return 1; }',
        /^property a of parameter o must be annotated as number or boolean \(declared string \| null\)$/,
      ],
      ['export function f(xs: number[]): number { return xs[5]; }', /beyond the 3 element slot/],
      ['export function f(o: { a: number }): number { const p = o; return p.a; }', /can only be read/],
    ];

    for (const [source, reason] of cases) {
      const result = translateFunction({ file: 'src/x.ts', source, exportName: 'f', domain: DOMAIN });
      expect(result.status, source).toBe('unsupported');

      if (result.status === 'unsupported') expect(result.reasons[0]?.reason, source).toMatch(reason);
    }
  });

  it('finds a record boundary bug and replays the reassembled counterexample in JavaScript', async () => {
    const root = project();
    const impl = translated(translate('discount'));
    const ir = thresholdProperty({
      implementation: impl,
      param: 'order__total',
      operator: '>=',
      value: '1000',
      whenTrue: '100',
      domain: DOMAIN,
    });
    const { claim, replay } = await prove(root, ir, 'discount');
    expect(FormalClaim.parse(claim)).toBeTruthy();
    expect(claim.status).toBe('counterexample_found');
    expect(claim.semanticValidation).toBe('confirmed');
    expect(claim.counterexample).toMatchObject({ order: { total: '1000' } });
    expect(typeof (claim.counterexample as { order: { vip: unknown } }).order.vip).toBe('boolean');
    expect(replay[0]?.javascript).toEqual({ t: 'number', v: replay[0]?.model });

    const fixed = translated(translate('fixedDiscount'));
    const fixedIr = thresholdProperty({
      implementation: fixed,
      param: 'order__total',
      operator: '>=',
      value: '1000',
      whenTrue: '100',
      domain: DOMAIN,
    });
    const proven = await prove(root, fixedIr, 'fixedDiscount');
    expect(proven.claim.status).toBe('proven_within_model');
    expect(proven.claim.semanticValidation).toBe('confirmed');
  }, 60_000);

  it('proves a guarded array function within the bounds and checks the model against JavaScript', async () => {
    const root = project();
    const sum = translated(translate('sumTwo'));
    expect(
      outOfBoundsProperty({
        irVersion: 1,
        params: sum.params,
        preconditions: [],
        functions: [sum.model],
        body: call('sumTwo', sum.params),
      }),
    ).not.toBeNull();
    // sumTwo(xs) == (length 0 ? 0 : length 1 ? xs[0] : xs[0] + xs[1]): the same function, written differently.
    const v = (name: string) => ({ kind: 'var' as const, name });
    const ir: PropertyIR = {
      irVersion: 1,
      params: sum.params,
      preconditions: [],
      functions: [sum.model],
      body: {
        kind: 'binary',
        op: 'implies',
        left: { kind: 'binary', op: '<=', left: v('xs__length'), right: { kind: 'int', value: '1' } },
        right: {
          kind: 'binary',
          op: '<=',
          left: call('sumTwo', sum.params),
          right: { kind: 'binary', op: '+', left: v('xs__0'), right: { kind: 'int', value: '10000' } },
        },
      },
    };
    const { claim, replay } = await prove(root, ir, 'sumTwo');
    expect(claim.status).toBe('proven_within_model');
    expect(claim.assumptions).toContain(
      'no array element is read at or beyond the array length (checked by solver)',
    );
    expect(replay.some((r) => r.purpose === 'differential' && r.agrees === true)).toBe(true);
  }, 60_000);

  it('never reports a function that can read beyond the array length as proven', async () => {
    const root = project();
    const unsafe = translated(translate('unsafeFirst'));
    const ir: PropertyIR = {
      irVersion: 1,
      params: unsafe.params,
      preconditions: [],
      functions: [unsafe.model],
      body: {
        kind: 'binary',
        op: '>=',
        left: call('unsafeFirst', unsafe.params),
        right: { kind: 'int', value: '0' },
      },
    };
    const { claim } = await prove(root, ir, 'unsafeFirst');
    expect(claim.status).toBe('unsupported');
    expect(claim.semanticGaps.join('\n')).toMatch(/read at or beyond the array's length .* \{"xs":\[\]\}/);
  }, 60_000);

  it('compares an original and a mutant that take a record', () => {
    const a = translated(translate('discount'));
    const b = translated(
      translateFunction({
        file: 'src/order.ts',
        source: SOURCE.replace('order.total > 1000', 'order.total >= 1000'),
        exportName: 'discount',
        domain: DOMAIN,
        modelName: 'mutant',
      }),
    );
    const ir = equivalenceProperty(a, b, DOMAIN);
    expect(ir.params.map((p) => p.name)).toEqual(['order__total', 'order__vip']);
  });

  it('reassembles flat inputs into the arguments of the model they belong to', () => {
    const xs = translated(translate('first'));
    const ir: PropertyIR = {
      irVersion: 1,
      params: xs.params,
      preconditions: [],
      functions: [xs.model],
      body: call('first', xs.params),
    };
    expect(shapeInput(ir, { xs__length: '2', xs__0: '7', xs__1: '-3', xs__2: '9' })).toEqual({
      xs: ['7', '-3'],
    });
    expect(shapeInput(ir, { other: true })).toEqual({ other: true });
  });
});
