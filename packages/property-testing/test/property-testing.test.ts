import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hashValue, RunStore } from '@veritas/core';
import { describe, expect, it } from 'vitest';
import { PbtResult, replayPropertyTest, runPropertyTest } from '../src/index.js';
import { discountProperty, fixture, opaqueProperty } from './helpers.js';

const SEED = 20251119;
const store = (root: string) =>
  new RunStore(root, 'run-pbt', { configHash: hashValue({}), sourceHash: hashValue([]), gitCommit: null });

describe('deliberately broken discountAmount (total > 1000 instead of >= 1000)', () => {
  it('finds a seeded counterexample shrunk to total = 1000, persists and replays it', async () => {
    const root = fixture();
    const { ir, bindings } = discountProperty(root, 'src/pricing.ts');
    const runStore = store(root);
    const options = {
      root,
      propertyId: 'P-discount-threshold',
      ir,
      bindings,
      seed: SEED,
      numRuns: 200,
      timeoutMs: 30_000,
      experimental: false,
    };
    const first = await runPropertyTest({ ...options, store: runStore });
    expect(PbtResult.parse(first)).toEqual(first);
    expect(first.status).toBe('counterexample');
    expect(first.trust).toBe('falsified');
    expect(first.counterexample).toEqual({ total: '1000' });
    expect(first.originalCounterexample).not.toBeNull();
    expect(first.failure).toEqual({
      reason: 'property_violated',
      javascript: { t: 'number', v: '0' },
      expected: '100',
    });
    expect(first.seed).toBe(SEED);
    expect(first.numRuns).toBe(200);
    expect(first.runsExecuted).toBeGreaterThan(0);
    expect(first.runsExecuted).toBeLessThanOrEqual(200);
    expect(first.path).toMatch(/^\d+(:\d+)*$/);
    expect(first.domains).toEqual(ir.params);
    expect(first.replayCommand).toBe(`veritas test replay ${first.id} --seed ${SEED} --path ${first.path}`);
    expect(first.error).toBeNull();

    // Persisted with the failing input.
    const saved = runStore.read(`pbt/${first.id}.json`, PbtResult);
    expect(saved.data.counterexample).toEqual({ total: '1000' });
    expect(saved.data.originalCounterexample).toEqual(first.originalCounterexample);

    // Same seed: identical result and id.
    const second = await runPropertyTest(options);
    expect(second.id).toBe(first.id);
    expect(second.counterexample).toEqual(first.counterexample);
    expect(second.originalCounterexample).toEqual(first.originalCounterexample);
    expect(second.path).toBe(first.path);
    expect(second.shrinks).toBe(first.shrinks);

    // Replay from the stored record goes straight to the shrunk input through the replay path.
    const replayed = await replayPropertyTest(saved.data, { root, ir, bindings, timeoutMs: 30_000 });
    expect(replayed.status).toBe('counterexample');
    expect(replayed.id).toBe(first.id);
    expect(replayed.counterexample).toEqual({ total: '1000' });
    expect(replayed.failure).toEqual(first.failure);
  }, 60_000);

  it('a different seed is a different, but still deterministic, run id', async () => {
    const root = fixture();
    const { ir, bindings } = discountProperty(root, 'src/pricing.ts');
    const base = { root, propertyId: 'P', ir, bindings, numRuns: 50, timeoutMs: 30_000, experimental: true };
    const a = await runPropertyTest({ ...base, seed: 1 });
    const b = await runPropertyTest({ ...base, seed: 2 });
    expect(a.id).not.toBe(b.id);
    expect(a.experimental).toBe(true);
  }, 60_000);

  it('records a random seed when none is given', async () => {
    const root = fixture();
    const { ir, bindings } = discountProperty(root, 'candidates/pricing-fixed.ts');
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      numRuns: 20,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(Number.isInteger(result.seed)).toBe(true);
    expect(result.replayCommand).toBe(`veritas test replay ${result.id} --seed ${result.seed}`);
  }, 60_000);

  it('rejects a replay whose IR domains differ from the record', async () => {
    const root = fixture();
    const { ir, bindings } = discountProperty(root, 'src/pricing.ts');
    const first = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 200,
      timeoutMs: 30_000,
      experimental: false,
    });
    const narrowed = {
      ...ir,
      params: ir.params.map((p) => (p.sort === 'int' ? { ...p, domain: { min: '0', max: '10' } } : p)),
    };
    const replayed = await replayPropertyTest(first, { root, ir: narrowed, bindings, timeoutMs: 30_000 });
    expect(replayed.status).toBe('error');
    expect(replayed.trust).toBe('unknown');
    expect(replayed.error).toMatch(/domains differ/);
  }, 60_000);
});

describe('conforming candidates/pricing-fixed.ts', () => {
  it('passes and is only empirically supported, never proven', async () => {
    const root = fixture();
    const { ir, bindings } = discountProperty(root, 'candidates/pricing-fixed.ts');
    const result = await runPropertyTest({
      root,
      propertyId: 'P-discount-threshold',
      ir,
      bindings,
      seed: SEED,
      numRuns: 300,
      timeoutMs: 30_000,
      experimental: false,
      store: store(root),
    });
    expect(result.status).toBe('passed');
    expect(result.trust).toBe('empirically_supported');
    expect(result.runsExecuted).toBe(300);
    expect(result.counterexample).toBeNull();
    expect(result.failure).toBeNull();
    expect(result.path).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/proven|proof/);
    const raw = readFileSync(path.join(root, '.veritas/runs/run-pbt/pbt', `${result.id}.json`), 'utf8');
    expect(raw).not.toMatch(/proven/);
  }, 60_000);
});

describe('results outside the integer model', () => {
  it.each([
    [
      'NaN',
      'export function f(x: number): number { return x >= 5000 ? NaN : 1; }',
      { t: 'number', v: 'NaN' },
    ],
    [
      'a float',
      'export function f(x: number): number { return x >= 5000 ? 1.5 : 1; }',
      { t: 'number', v: '1.5' },
    ],
    [
      'a string',
      "export function f(x: number): number { return (x >= 5000 ? '7' : 1) as unknown as number; }",
      { t: 'string', v: '7' },
    ],
    [
      'an unsafe integer',
      'export function f(x: number): number { return x >= 5000 ? 2 ** 60 : 1; }',
      { t: 'number', v: String(2 ** 60) },
    ],
  ])(
    '%s is non_integer_result, never coerced',
    async (_label, source, javascript) => {
      const root = fixture();
      const { ir, bindings } = opaqueProperty(root, source);
      const result = await runPropertyTest({
        root,
        propertyId: 'P',
        ir,
        bindings,
        seed: SEED,
        numRuns: 200,
        timeoutMs: 30_000,
        experimental: false,
      });
      expect(result.status).toBe('counterexample');
      expect(result.trust).toBe('falsified');
      expect(result.failure).toEqual({ reason: 'non_integer_result', javascript });
      expect(result.counterexample).toEqual({ x: '5000' });
    },
    60_000,
  );

  it('-0 is read as 0 (documented), so it satisfies f(x) >= 0', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, 'export function f(x: number): number { return -0; }');
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 50,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('passed');
  }, 60_000);

  it('a non-boolean result for a boolean model is non_boolean_result', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(
      root,
      'export function f(x: number): boolean { return (x > 0 ? 1 : true) as unknown as boolean; }',
      { returns: 'bool' },
    );
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 100,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('counterexample');
    expect(result.failure).toEqual({ reason: 'non_boolean_result', javascript: { t: 'number', v: '1' } });
    expect(result.counterexample).toEqual({ x: '1' });
  }, 60_000);

  it('a thrown error is a counterexample with reason threw', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(
      root,
      "export function f(x: number): number { if (x < 0) throw new RangeError('negative'); return x; }",
    );
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 100,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('counterexample');
    expect(result.failure).toEqual({
      reason: 'threw',
      javascript: { t: 'throw', v: 'RangeError: negative' },
    });
    expect(result.counterexample).toEqual({ x: '-1' });
  }, 60_000);
});

describe('timeouts, cancellation and errors', () => {
  const loop = 'export function f(x: number): number { for (;;) {} }';

  it('an infinite loop is a timeout, not a pass', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, loop);
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 10,
      timeoutMs: 2_000,
      experimental: false,
    });
    expect(result.status).toBe('timeout');
    expect(result.trust).toBe('unknown');
    expect(result.runsExecuted).toBeNull();
    expect(result.error).toMatch(/2000 ms/);
  }, 30_000);

  it('an abort signal cancels the run', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, loop);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 10,
      timeoutMs: 20_000,
      experimental: false,
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(result.trust).toBe('unknown');
    expect(result.durationMs).toBeLessThan(20_000);
  }, 30_000);

  it('an already aborted signal never starts the run', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, 'export function f(x: number): number { return 1; }');
    const controller = new AbortController();
    controller.abort();
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 10,
      timeoutMs: 20_000,
      experimental: false,
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
  });

  it('a missing export is an error', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, 'export function g(x: number): number { return x; }');
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 10,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('error');
    expect(result.trust).toBe('unknown');
    expect(result.error).toMatch(/export f is not a function/);
    expect(result.counterexample).toBeNull();
  }, 30_000);

  it('a module path outside the project root is an error', async () => {
    const root = fixture();
    const { ir } = opaqueProperty(root, 'export function f(x: number): number { return x; }');
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings: [{ modelName: 'f', modulePath: path.join(root, '..', 'elsewhere.ts'), exportName: 'f' }],
      seed: SEED,
      numRuns: 10,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('error');
  });

  it('an opaque, unbound function in the IR is an error', async () => {
    const root = fixture();
    const { ir } = opaqueProperty(root, 'export function f(x: number): number { return x; }');
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings: [],
      seed: SEED,
      numRuns: 10,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/opaque and not bound/);
  });

  it('a domain beyond the safe-integer range is an error', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, 'export function f(x: number): number { return 1; }');
    const wide = {
      ...ir,
      params: [{ name: 'x', sort: 'int' as const, domain: { min: '0', max: '9007199254740992' } }],
    };
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir: wide,
      bindings,
      seed: SEED,
      numRuns: 10,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/safe-integer range/);
  });

  it('an IR evaluation error is reported as error, not as a falsification', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, 'export function f(x: number): number { return 0; }');
    const divByCall = {
      ...ir,
      body: {
        kind: 'binary' as const,
        op: '>=' as const,
        left: {
          kind: 'binary' as const,
          op: 'div' as const,
          left: { kind: 'int' as const, value: '1' },
          right: { kind: 'call' as const, fn: 'f', args: [{ kind: 'var' as const, name: 'x' }] },
        },
        right: { kind: 'int' as const, value: '0' },
      },
    };
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir: divByCall,
      bindings,
      seed: SEED,
      numRuns: 10,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('error');
    expect(result.trust).toBe('unknown');
    expect(result.failure).toEqual({ reason: 'model_error' });
    expect(result.error).toMatch(/division by zero/);
  }, 30_000);

  it('rejects invalid run options', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(root, 'export function f(x: number): number { return 1; }');
    const base = { root, propertyId: 'P', ir, bindings, timeoutMs: 1_000, experimental: false };
    await expect(runPropertyTest({ ...base, numRuns: 0 })).rejects.toThrow(/numRuns/);
    await expect(runPropertyTest({ ...base, numRuns: 1, seed: 1.5 })).rejects.toThrow(/seed/);
    await expect(
      runPropertyTest({ ...base, numRuns: 1, ir: { ...ir, irVersion: 2 } as unknown as typeof ir }),
    ).rejects.toThrow(/invalid property IR/);
  });
});

describe('sandbox', () => {
  it('an implementation cannot write files', async () => {
    const root = fixture();
    const target = path.join(root, 'pwned.txt');
    const { ir, bindings } = opaqueProperty(
      root,
      `import { writeFileSync } from 'node:fs';\nexport function f(x: number): number { writeFileSync(${JSON.stringify(target)}, 'x'); return 1; }`,
    );
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 5,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(existsSync(target)).toBe(false);
    expect(result.status).toBe('counterexample');
    expect(result.failure?.reason).toBe('threw');
    expect(JSON.stringify(result.failure?.javascript)).toMatch(/ERR_ACCESS_DENIED/);
  }, 30_000);

  it('an implementation cannot spawn a process', async () => {
    const root = fixture();
    const target = path.join(root, 'spawned.txt');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')`;
    const { ir, bindings } = opaqueProperty(
      root,
      `import { spawnSync } from 'node:child_process';\nexport function f(x: number): number { const r = spawnSync(process.execPath, ['-e', ${JSON.stringify(script)}]); if (r.error) throw r.error; return r.status === 0 ? 1 : -1; }`,
    );
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 5,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(existsSync(target)).toBe(false);
    expect(result.status).toBe('counterexample');
    expect(JSON.stringify(result.failure?.javascript)).toMatch(/ERR_ACCESS_DENIED/);
  }, 30_000);

  it('side effects at import time are blocked and reported as error', async () => {
    const root = fixture();
    const target = path.join(root, 'import-time.txt');
    const { ir, bindings } = opaqueProperty(
      root,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(target)}, 'x');\nexport function f(x: number): number { return 1; }`,
    );
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 5,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(existsSync(target)).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/ERR_ACCESS_DENIED/);
  }, 30_000);

  it('output printed by the implementation cannot forge a result', async () => {
    const root = fixture();
    const { ir, bindings } = opaqueProperty(
      root,
      `console.log('@@veritas-pbt:0@@' + JSON.stringify({ ok: true, failed: false }));\nexport function f(x: number): number { return -1; }`,
    );
    const result = await runPropertyTest({
      root,
      propertyId: 'P',
      ir,
      bindings,
      seed: SEED,
      numRuns: 5,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('counterexample');
  }, 30_000);
});
