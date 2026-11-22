import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type PropertyIR, RunStore } from '@under18dev/veritas-core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as emit from '../src/emit.js';
import {
  detectLean,
  LeanAttempt,
  type LeanInstallation,
  type LeanStrategy,
  proveWithLean,
} from '../src/index.js';

// Only the strategy list is replaced, so that a strategy abandoned at its generation budget can sit next to real
// ones; translation, Lake and the kernel check stay real.
vi.mock('../src/emit.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/emit.js')>();

  return { ...original, leanProofStrategies: vi.fn(original.leanProofStrategies) };
});

const LEAN_TIMEOUT = 120_000;
const REASON = 'generated script exceeded the 2000-named-result budget';

/** x within [0, 5] implies x >= 0: the first real strategy proves it. */
const IR: PropertyIR = {
  irVersion: 1,
  params: [{ name: 'x', sort: 'int', domain: { min: '0', max: '5' } }],
  preconditions: [],
  functions: [],
  body: { kind: 'binary', op: '>=', left: { kind: 'var', name: 'x' }, right: { kind: 'int', value: '0' } },
};

const skipped: LeanStrategy = { name: 'name-int-calls-cases', script: [], skipReason: REASON };

let lean: LeanInstallation;
beforeAll(async () => {
  lean = await detectLean();
}, 600_000);

describe('strategies abandoned at their generation budget (real Lean)', () => {
  it(
    'are recorded as skipped with their reason, and never win',
    async () => {
      expect(lean.available, `Lean 4 and lake are required for this test: ${lean.detail}`).toBe(true);
      const real = vi.mocked(emit.leanProofStrategies).getMockImplementation()?.(IR) ?? [];
      vi.mocked(emit.leanProofStrategies).mockReturnValueOnce([skipped, ...real]);
      const store = new RunStore(mkdtempSync(path.join(tmpdir(), 'veritas-lean-skip-')), 'run-skip', {
        configHash: 'c',
        sourceHash: 's',
        gitCommit: null,
      });
      const { claim, check, strategy, attempts } = await proveWithLean({
        propertyId: 'P-skip',
        ir: IR,
        timeoutMs: LEAN_TIMEOUT,
        store,
      });
      expect(check.status).toBe('kernel_checked');
      expect(claim.status).toBe('proven_within_model');
      expect(strategy).toBe(real[0]?.name);
      expect(attempts[0]).toEqual({
        strategy: 'name-int-calls-cases',
        status: 'skipped',
        reasons: [REASON],
        durationMs: 0,
        source: '',
      });
      expect(attempts.slice(1).map((a) => a.status)).toEqual(['kernel_checked']);
      // The test store's metadata is placeholder; only the recorded attempts are checked.
      const envelope = JSON.parse(
        readFileSync(store.pathFor(`proofs/lean/${claim.id}.attempts.json`), 'utf8'),
      );
      const recorded = LeanAttempt.array().parse(envelope.data);
      expect(recorded.map((a) => a.status)).toEqual(['skipped', 'kernel_checked']);
      expect(recorded[0]?.reasons).toEqual([REASON]);
    },
    LEAN_TIMEOUT * 2,
  );

  it(
    'leave the claim in error, with their reasons, when every strategy was skipped',
    async () => {
      expect(lean.available, `Lean 4 and lake are required for this test: ${lean.detail}`).toBe(true);
      vi.mocked(emit.leanProofStrategies).mockReturnValueOnce([skipped]);
      const { claim, check, strategy, attempts } = await proveWithLean({
        propertyId: 'P-skip-all',
        ir: IR,
        timeoutMs: LEAN_TIMEOUT,
      });
      expect(check.status).toBe('error');
      expect(claim.status).toBe('error');
      expect(claim.assurance).toBe('none');
      expect(strategy).toBeNull();
      expect(attempts.map((a) => a.status)).toEqual(['skipped']);
      expect(check.reasons).toEqual([`name-int-calls-cases: ${REASON}`]);
    },
    LEAN_TIMEOUT,
  );
});
