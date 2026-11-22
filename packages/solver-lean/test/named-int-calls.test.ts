import { holdsForAllProperty, translateFunction } from '@under18dev/veritas-formal-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  detectLean,
  irToLean,
  type LeanInstallation,
  leanProofStrategies,
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
