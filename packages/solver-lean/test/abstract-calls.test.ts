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
 * A decision kernel in the style of the run policy: a rule chosen by a chain of comparisons, mapped to a verdict and
 * an exit code, with invariants that use the result of the chain several times. Unfolding everything copies the
 * chain into every use.
 */
const SOURCE = `export interface Counts {
  failures: number;
  errors: number;
  open: number;
  undecided: number;
  failOnUndecided: boolean;
}
function rule(c: Counts): number {
  if (c.failures > 0) return 0;
  if (c.errors > 0) return 1;
  if (c.undecided > 0 && c.failOnUndecided) return 2;
  if (c.open > 0 || c.undecided > 0) return 3;
  return 4;
}
function verdict(r: number): number {
  if (r === 0) return 2;
  if (r === 1) return 3;
  if (r === 2) return 4;
  if (r === 3) return 1;
  return 0;
}
function exitCode(v: number): number {
  if (v === 2) return 1;
  if (v === 3) return 3;
  if (v === 4) return 4;
  return 0;
}
export function invariant_exitFollowsVerdict(c: Counts): boolean {
  const v = verdict(rule(c));
  const exit = exitCode(v);
  return (v !== 2 || exit === 1) && (v !== 3 || exit === 3) && (v !== 4 || exit === 4) && ((v !== 0 && v !== 1) || exit === 0);
}
export function invariant_passMeansNothingOpen(c: Counts): boolean {
  return verdict(rule(c)) !== 0 || (c.failures <= 0 && c.errors <= 0 && c.open <= 0 && c.undecided <= 0);
}
export function invariant_wrong(c: Counts): boolean {
  return exitCode(verdict(rule(c))) !== 0 || c.open <= 0;
}
export function plain(x: number): boolean {
  return x >= 0 || x < 0;
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

describe('abstract-calls-split', () => {
  it('is tried first when the functions the property calls call others, and not offered otherwise', () => {
    expect(leanProofStrategies(holds('invariant_exitFollowsVerdict')).map((s) => s.name)).toEqual([
      'abstract-calls-split',
      'unfold-split-omega',
      'simp-split-omega',
    ]);
    expect(leanProofStrategies(holds('plain')).map((s) => s.name)).toEqual([
      'unfold-split-omega',
      'simp-split-omega',
    ]);
  });

  it('names the innermost call once, however often its result is used', () => {
    const [strategy] = leanProofStrategies(holds('invariant_exitFollowsVerdict'));
    const script = strategy?.script.join('\n') ?? '';
    expect(script.match(/obtain ⟨r_\d+, hr_\d+⟩/g)).toHaveLength(1);
    expect(script).toContain('«f_invariant_exitFollowsVerdict__rule»');
    expect(script).not.toMatch(/\bsorry\b|\badmit\b|\baxiom\b/);
    // The source is the same Lean model; only the tactic script differs.
    const source = irToLean(holds('invariant_exitFollowsVerdict'), { theoremName: 't', strategy });
    expect(source).toContain('theorem «t»');
  });

  it(
    'lets the Lean kernel check invariants that the full unfolding cannot, and never proves a false one',
    async () => {
      expect(lean.available, `Lean 4 and lake are required for this test: ${lean.detail}`).toBe(true);

      for (const name of ['invariant_exitFollowsVerdict', 'invariant_passMeansNothingOpen']) {
        const { claim, check, strategy } = await proveWithLean({
          propertyId: `D-${name}`,
          ir: holds(name),
          timeoutMs: LEAN_TIMEOUT,
        });
        expect(check.status, `${name}: ${check.reasons.join('\n')}`).toBe('kernel_checked');
        expect(claim.status).toBe('proven_within_model');
        expect(claim.assurance).toBe('kernel_checked');
        expect(strategy).toBe('abstract-calls-split');
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
