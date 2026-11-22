import type { Expr, PropertyIR } from '@under18dev/veritas-core';
import { holdsForAllProperty, translateFunction } from '@under18dev/veritas-formal-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  detectLean,
  irToLean,
  type LeanInstallation,
  leanProofStrategies,
  leanTranslatable,
  proveWithLean,
} from '../src/index.js';

const LEAN_TIMEOUT = 120_000;

/**
 * A decision kernel over a record with many flags, in the style of the test-outcome kernel: a rule code chosen by
 * a decision list, mapped to an outcome code by a second list that reads the rule code several times. Splitting
 * every flag up front gives 2^9 goals, each with a copy of the whole list per use of the rule code.
 */
const SOURCE = `export interface Evidence {
  a: boolean;
  b: boolean;
  c: boolean;
  d: boolean;
  e: boolean;
  f: boolean;
  g: boolean;
  h: boolean;
  i: boolean;
  n: number;
}
function either(x: Evidence): boolean {
  return x.e || x.f;
}
function rule(x: Evidence): number {
  if (x.a) return 0;
  if (x.b && x.c) return 1;
  if (x.n > 0 && !x.d) return 2;
  if (either(x)) return 3;
  if (x.g || x.i) return 4;
  return 5;
}
function code(r: number): number {
  if (r === 0) return 3;
  if (r === 2) return 1;
  if (r === 5) return 0;
  return 2;
}
function outcome(x: Evidence): number {
  return code(rule(x));
}
export function invariant_zeroNeedsAll(x: Evidence): boolean {
  return outcome(x) !== 0 || (!x.a && !either(x) && !x.g && !x.i && (x.n <= 0 || x.d));
}
export function invariant_sameWithoutH(x: Evidence): boolean {
  return outcome(x) === outcome({ a: x.a, b: x.b, c: x.c, d: x.d, e: x.e, f: x.f, g: x.g, h: false, i: x.i, n: x.n });
}
export function invariant_wrong(x: Evidence): boolean {
  return outcome(x) !== 1 || x.h;
}
`;

function holds(exportName: string) {
  const result = translateFunction({
    file: 'src/kernel.ts',
    source: SOURCE,
    exportName,
    domain: { min: '-10000', max: '10000' },
  });

  if (result.status !== 'translated') throw new Error(JSON.stringify(result));

  return holdsForAllProperty(result, { min: '-10000', max: '10000' });
}

let lean: LeanInstallation;
beforeAll(async () => {
  lean = await detectLean();
}, 600_000);

describe('name-int-calls-cases', () => {
  it('is tried first when there are more boolean parameters than are split up front', () => {
    expect(leanProofStrategies(holds('invariant_zeroNeedsAll'))[0]?.name).toBe('name-int-calls-cases');
  });

  it('names every integer call once and proves its helper lemma in the same file', () => {
    const ir = holds('invariant_sameWithoutH');
    const strategy = leanProofStrategies(ir).find((s) => s.name === 'name-int-calls-cases');
    const script = strategy?.script.join('\n') ?? '';
    // Two calls of outcome with different records, each with its own rule and code.
    expect(script.match(/obtain ⟨«v_r\$\d+», hc_\d+, hr_\d+⟩/g)).toHaveLength(6);
    expect(script).not.toMatch(/\bsorry\b|\badmit\b|\baxiom\b|native_decide/);
    // Two codes: each is replaced by its value once decided, instead of splitting both up front.
    expect(script).toContain('obtain rfl');
    expect(script).not.toContain('split at');
    const single = leanProofStrategies(holds('invariant_zeroNeedsAll'))[0]?.script.join('\n') ?? '';
    expect(single).toContain('split at');
    expect(single).not.toContain('obtain rfl');
    const source = irToLean(ir, { theoremName: 't', strategy });
    expect(source).toContain('theorem veritas_ite_eq');
    expect(source.indexOf('theorem veritas_ite_eq')).toBeLessThan(source.indexOf('theorem «t»'));
    expect(source).toMatch(/set_option maxHeartbeats \d+ in\nopen VeritasModel in\ntheorem «t»/);
  });

  it('turns down opaque functions with a VeritasError, without generating a script', async () => {
    const flags = Array.from({ length: 9 }, (_, i) => ({ name: `b${i}`, sort: 'bool' as const }));
    const ir: PropertyIR = {
      irVersion: 1,
      params: [...flags, { name: 'x', sort: 'int', domain: { min: '-5', max: '5' } }],
      preconditions: [],
      functions: [
        { name: 'g', symbol: 's#g', params: [{ name: 'a', sort: 'int' }], returns: 'int', body: null },
      ],
      body: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'call', fn: 'g', args: [{ kind: 'var', name: 'x' }] },
        right: { kind: 'int', value: '0' },
      },
    };
    expect(leanProofStrategies(ir).map((s) => s.name)).not.toContain('name-int-calls-cases');
    expect(leanTranslatable(ir)).toBe(false);
    const { claim } = await proveWithLean({ propertyId: 'D-opaque', ir, timeoutMs: LEAN_TIMEOUT });
    expect(claim.status).toBe('unsupported');
  });

  it('is not offered when inlining the boolean helpers would blow up, and decides that quickly', () => {
    // h0(p) = p.b0 && p.b1; h_k(p) = h_{k-1}(p) || !h_{k-1}(p): each level doubles the inlined term.
    const flags = Array.from({ length: 9 }, (_, i) => ({ name: `b${i}`, sort: 'bool' as const }));
    const args: Expr[] = [
      ...flags.map((f) => ({ kind: 'var', name: f.name }) as Expr),
      { kind: 'var', name: 'x' },
    ];
    const params = [
      ...flags.map((f) => ({ name: f.name, sort: 'bool' as const })),
      { name: 'x', sort: 'int' as const },
    ];
    const levels = 40;
    const functions: PropertyIR['functions'] = [
      {
        name: 'h0',
        symbol: 's#h0',
        params,
        returns: 'bool',
        body: { kind: 'binary', op: 'and', left: args[0] as Expr, right: args[1] as Expr },
      },
    ];

    for (let k = 1; k < levels; k++) {
      const prev: Expr = { kind: 'call', fn: `h${k - 1}`, args };
      functions.push({
        name: `h${k}`,
        symbol: `s#h${k}`,
        params,
        returns: 'bool',
        body: { kind: 'binary', op: 'or', left: prev, right: { kind: 'unary', op: 'not', arg: prev } },
      });
    }
    functions.push({
      name: 'code',
      symbol: 's#code',
      params,
      returns: 'int',
      body: {
        kind: 'ite',
        cond: { kind: 'call', fn: `h${levels - 1}`, args },
        whenTrue: { kind: 'int', value: '1' },
        whenFalse: { kind: 'int', value: '0' },
      },
    });
    const ir: PropertyIR = {
      irVersion: 1,
      params: [...flags, { name: 'x', sort: 'int', domain: { min: '-5', max: '5' } }],
      preconditions: [],
      functions,
      body: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'call', fn: 'code', args },
        right: { kind: 'int', value: '0' },
      },
    };
    const started = Date.now();
    const names = leanProofStrategies(ir).map((s) => s.name);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(names).not.toContain('name-int-calls-cases');
  });

  it('measures deeply nested calls in linear time', () => {
    // id(id(...id(b0))) with id(p) = p: every argument is measured once, however deep the nesting.
    const flags = Array.from({ length: 9 }, (_, i) => ({ name: `b${i}`, sort: 'bool' as const }));
    let nested: Expr = { kind: 'var', name: 'b0' };

    for (let k = 0; k < 400; k++) nested = { kind: 'call', fn: 'id', args: [nested] };
    const ir: PropertyIR = {
      irVersion: 1,
      params: [...flags, { name: 'x', sort: 'int', domain: { min: '-5', max: '5' } }],
      preconditions: [],
      functions: [
        {
          name: 'id',
          symbol: 's#id',
          params: [{ name: 'p', sort: 'bool' }],
          returns: 'bool',
          body: { kind: 'var', name: 'p' },
        },
        {
          name: 'code',
          symbol: 's#code',
          params: [{ name: 'c', sort: 'bool' }],
          returns: 'int',
          body: {
            kind: 'ite',
            cond: { kind: 'var', name: 'c' },
            whenTrue: { kind: 'int', value: '1' },
            whenFalse: { kind: 'int', value: '0' },
          },
        },
      ],
      body: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'call', fn: 'code', args: [nested] },
        right: { kind: 'int', value: '0' },
      },
    };
    const started = Date.now();
    const names = leanProofStrategies(ir).map((s) => s.name);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(names[0]).toBe('name-int-calls-cases');
  });

  it('generates its script only when an attempt reads it', () => {
    const strategy = leanProofStrategies(holds('invariant_zeroNeedsAll'))[0];
    const descriptor = strategy ? Object.getOwnPropertyDescriptor(strategy, 'script') : undefined;
    expect(typeof descriptor?.get).toBe('function');
  });

  it(
    'lets the Lean kernel check invariants over many flags, and never proves a false one',
    async () => {
      expect(lean.available, `Lean 4 and lake are required for this test: ${lean.detail}`).toBe(true);

      for (const name of ['invariant_zeroNeedsAll', 'invariant_sameWithoutH']) {
        const { claim, check, strategy } = await proveWithLean({
          propertyId: `D-${name}`,
          ir: holds(name),
          timeoutMs: LEAN_TIMEOUT,
        });
        expect(check.status, `${name}: ${check.reasons.join('\n')}`).toBe('kernel_checked');
        expect(claim.status).toBe('proven_within_model');
        expect(claim.assurance).toBe('kernel_checked');
        expect(strategy).toBe('name-int-calls-cases');
      }
      const wrong = await proveWithLean({
        propertyId: 'D-wrong',
        ir: holds('invariant_wrong'),
        timeoutMs: LEAN_TIMEOUT,
      });
      expect(wrong.claim.status).toBe('unknown');
      expect(wrong.claim.assurance).toBe('none');
      expect(wrong.strategy).toBeNull();
    },
    LEAN_TIMEOUT * 8,
  );
});
