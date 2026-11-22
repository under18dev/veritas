import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Expr, FormalClaim, type PropertyIR } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  outOfBoundsProperty,
  proveProperty,
  type TranslationResult,
  translateFunction,
} from '../src/index.js';

const DOMAIN = { min: '-1000', max: '1000' };
const SOURCE = `export interface Evidence {
  killed: number;
  asserted: boolean;
}
interface SameShape {
  asserted: boolean;
  killed: number;
}
function meaningful(e: Evidence): boolean {
  return e.asserted && e.killed >= 1;
}
function weighted(e: SameShape, bonus: number): number {
  return e.asserted ? e.killed + bonus : 0;
}
export function outcome(e: Evidence): number {
  return meaningful(e) ? 2 : e.killed > 0 ? 1 : 0;
}
export function invariant(e: Evidence): boolean {
  return !meaningful(e) || outcome(e) === 2;
}
export function assumeAsserted(e: Evidence): boolean {
  return !meaningful({ killed: e.killed, asserted: true }) || e.asserted;
}
export function shorthand(killed: number, asserted: boolean): boolean {
  return meaningful({ asserted, killed });
}
export function sameShape(e: Evidence): number {
  return weighted(e, 1);
}
function head(xs: number[]): number {
  return xs[0];
}
export function guardedHead(xs: number[]): number {
  return xs.length > 0 ? head(xs) : 0;
}
export function unguardedHead(xs: number[]): number {
  return head(xs);
}
`;

function translate(exportName: string, source = SOURCE) {
  return translateFunction({ file: 'src/evidence.ts', source, exportName, domain: DOMAIN });
}

function translated(result: TranslationResult) {
  if (result.status !== 'translated') throw new Error(`expected translation, got ${JSON.stringify(result)}`);

  return result;
}

const v = (name: string): Expr => ({ kind: 'var', name });

/** `fn(params) == true` over the translated function and its callees. */
function holds(t: Extract<TranslationResult, { status: 'translated' }>): PropertyIR {
  return {
    irVersion: 1,
    params: t.params,
    preconditions: [],
    functions: [t.model, ...t.dependencies],
    body: { kind: 'call', fn: t.model.name, args: t.params.map((p) => v(p.name)) },
  };
}

/** A project whose `src/evidence.ts` holds `source` (by default the translated source). */
function project(source = SOURCE): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-record-args-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'src/evidence.ts'), source);

  return root;
}

function prove(root: string, ir: PropertyIR, exportName: string) {
  return proveProperty({
    kind: 'conformance',
    propertyId: 'P-record-args',
    ir,
    root,
    bindings: [{ modelName: exportName, modulePath: path.join(root, 'src/evidence.ts'), exportName }],
    timeoutMs: 10_000,
  });
}

/** The call expressions in `e`, outermost first. */
function calls(e: Expr): Extract<Expr, { kind: 'call' }>[] {
  switch (e.kind) {
    case 'call':
      return [e, ...e.args.flatMap(calls)];
    case 'unary':
      return calls(e.arg);
    case 'binary':
      return [...calls(e.left), ...calls(e.right)];
    case 'ite':
      return [...calls(e.cond), ...calls(e.whenTrue), ...calls(e.whenFalse)];
    default:
      return [];
  }
}

describe('record and array arguments to functions in the same file', () => {
  it('passes a record parameter as its flattened fields', () => {
    const t = translated(translate('outcome'));
    const call = calls(t.model.body as Expr).find((c) => c.fn === 'outcome__meaningful');
    expect(call?.args).toEqual([v('e__killed'), v('e__asserted')]);
    expect(t.dependencies.map((d) => d.name)).toEqual(['outcome__meaningful']);
  });

  it('passes an object literal field by field, in the order the callee declares', () => {
    const t = translated(translate('assumeAsserted'));
    const call = calls(t.model.body as Expr).find((c) => c.fn === 'assumeAsserted__meaningful');
    expect(call?.args).toEqual([v('e__killed'), { kind: 'bool', value: true }]);
    const short = translated(translate('shorthand'));
    expect(calls(short.model.body as Expr)[0]?.args).toEqual([v('killed'), v('asserted')]);
  });

  it('accepts a record of another declared type with exactly the same fields, plus scalar arguments', () => {
    const t = translated(translate('sameShape'));
    expect(calls(t.model.body as Expr)[0]?.args).toEqual([
      v('e__asserted'),
      v('e__killed'),
      { kind: 'int', value: '1' },
    ]);
  });

  it('passes an array parameter and carries the callee bounds obligation over to the caller', () => {
    const guarded = translated(translate('guardedHead'));
    expect(calls(guarded.model.body as Expr)[0]?.args).toEqual([
      v('xs__length'),
      v('xs__0'),
      v('xs__1'),
      v('xs__2'),
    ]);
    expect(guarded.model.outOfBounds).toHaveLength(1);
    expect(outOfBoundsProperty(holds(guarded))).not.toBeNull();
    expect(translated(translate('unguardedHead')).model.outOfBounds).toHaveLength(1);
  });

  it('keeps every other record or array argument unsupported, with the reason', () => {
    const callee = 'function g(r: { a: number; b: boolean }): number { return r.b ? r.a : 0; }\n';
    const cases: [string, RegExp][] = [
      [
        'export function f(r: { a: number; b: boolean }): number { return g({ ...r }); }',
        /spread properties/,
      ],
      ['export function f(x: number): number { return g({ ["a"]: x, b: true }); }', /computed/],
      ['export function f(x: number): number { return g({ a: x }); }', /property b is missing/],
      [
        'export function f(x: number): number { return g({ a: x, b: true, c: 1 }); }',
        /property c is not declared/,
      ],
      [
        'export function f(x: number): number { return g({ a: x, a: x, b: true }); }',
        /property a is given twice/,
      ],
      [
        'export function f(x: number): number { return g({ a() { return 1; }, b: true }); }',
        /methods and accessors/,
      ],
      [
        'export function f(x: number): number { return g({ a: x > 0, b: true }); }',
        /must be a number, but x > 0 is a boolean/,
      ],
      [
        'export function f(r: { a: number; b: boolean; c: number }): number { return g(r); }',
        /r has property c, which parameter r of g does not declare/,
      ],
      ['export function f(r: { a: number }): number { return g(r); }', /r lacks property b/],
      [
        'export function f(r: { a: boolean; b: boolean }): number { return g(r); }',
        /property a of r is a boolean, but parameter r of g declares a number/,
      ],
      ['export function f(x: number): number { return g(x); }', /x is not a record parameter/],
      ['export function f(xs: number[]): number { return g(xs); }', /xs is not a record parameter/],
      [
        'export function f(r: { a: number; b: boolean }): number { const s = 1; return g(r) + g(k(s)); }\nfunction k(s: number): number { return s; }',
        /k\(s\) is neither a record parameter nor an object literal/,
      ],
      [
        'export function f(r: { a: number; b: boolean }): number { const r2 = { a: 1, b: true }; return g(r); }',
        /object literals are only supported as the record argument/,
      ],
      [
        'export function f(r: { a: number; b: boolean }): number { return g(r, 1); }',
        /g takes 1 argument\(s\) but is called with 2/,
      ],
      ['export function f(r: { a: number; b: boolean }): number { return g(...[r]); }', /spread arguments/],
    ];

    for (const [source, reason] of cases) {
      const result = translateFunction({
        file: 'src/x.ts',
        source: source + callee,
        exportName: 'f',
        domain: DOMAIN,
      });
      expect(result.status, source).toBe('unsupported');

      if (result.status === 'unsupported') expect(result.reasons[0]?.reason, source).toMatch(reason);
    }

    const shapes: [string, RegExp][] = [
      [
        'export function f(b: boolean): number { return g(b); }\nfunction g(x: number): number { return x; }',
        /argument x of g must be a number, but b is a boolean/,
      ],
      [
        'export function f(x: number): number { return g({ a: x }); }\nfunction g(r: { a?: number }): number { return 1; }',
        /optional property a/,
      ],
      [
        'export function f(x: number): number { return g({ a: { b: x } }); }\nfunction g(r: { a: { b: number } }): number { return 1; }',
        /property a of parameter r must be annotated as number or boolean/,
      ],
      [
        'export function f(xs: number[]): number { return g([1, 2]); }\nfunction g(ys: number[]): number { return ys.length; }',
        /\[1, 2\] is not an array parameter/,
      ],
      [
        'export function f(xs: boolean[]): number { return g(xs); }\nfunction g(ys: number[]): number { return ys.length; }',
        /xs holds booleans, but parameter ys of g holds numbers/,
      ],
      [
        'export function f(r: { a: number }): number { return g(r); }\nfunction g(ys: number[]): number { return ys.length; }',
        /r is not an array parameter/,
      ],
    ];

    for (const [source, reason] of shapes) {
      const result = translateFunction({ file: 'src/x.ts', source, exportName: 'f', domain: DOMAIN });
      expect(result.status, source).toBe('unsupported');

      if (result.status === 'unsupported') expect(result.reasons[0]?.reason, source).toMatch(reason);
    }
  });

  it('proves a property stated through record arguments and checks the model against JavaScript', async () => {
    const root = project();
    const { claim, replay } = await prove(root, holds(translated(translate('invariant'))), 'invariant');
    expect(FormalClaim.parse(claim)).toBeTruthy();
    expect(claim.status).toBe('proven_within_model');
    expect(claim.semanticValidation).toBe('confirmed');
    expect(replay.some((r) => r.purpose === 'differential' && r.agrees === true)).toBe(true);
  }, 60_000);

  it('finds a counterexample through an object literal argument and replays it as a record', async () => {
    const root = project();
    const { claim, replay } = await prove(
      root,
      holds(translated(translate('assumeAsserted'))),
      'assumeAsserted',
    );
    expect(claim.status).toBe('counterexample_found');
    expect(claim.semanticValidation).toBe('confirmed');
    const ce = claim.counterexample as { e: { killed: string; asserted: boolean } };
    expect(ce.e.asserted).toBe(false);
    expect(Number(ce.e.killed)).toBeGreaterThanOrEqual(1);
    expect(replay[0]?.purpose).toBe('counterexample');
    expect(replay[0]?.javascript).toEqual({ t: 'boolean', v: false });
  }, 60_000);

  it('reports a counterexample the JavaScript does not reproduce as a semantic mismatch', async () => {
    // The code on disk ignores the record argument; the model was translated from SOURCE.
    const root = project(
      SOURCE.replace(
        'return !meaningful({ killed: e.killed, asserted: true }) || e.asserted;',
        'return true;',
      ),
    );
    const { claim, replay } = await prove(
      root,
      holds(translated(translate('assumeAsserted'))),
      'assumeAsserted',
    );
    expect(claim.status).toBe('semantic_mismatch');
    expect(claim.semanticValidation).toBe('mismatch');
    expect(replay[0]?.agrees).toBe(false);
    expect(claim.counterexample).toMatchObject({ e: { asserted: false } });
  }, 60_000);

  it('never proves a property whose callee can read beyond the array length', async () => {
    const root = project();
    const t = translated(translate('unguardedHead'));
    const ir: PropertyIR = {
      ...holds(t),
      body: {
        kind: 'binary',
        op: '==',
        left: { kind: 'call', fn: t.model.name, args: t.params.map((p) => v(p.name)) },
        right: v('xs__0'),
      },
    };
    const { claim } = await prove(root, ir, 'unguardedHead');
    expect(claim.status).toBe('unsupported');
    expect(claim.semanticGaps.join('\n')).toMatch(/read at or beyond the array's length .* \{"xs":\[\]\}/);
  }, 60_000);
});
