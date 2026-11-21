import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PropertyIR } from '@under18dev/veritas-core';
import { thresholdProperty, translateFunction } from '@under18dev/veritas-formal-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { generateTestFile, runPropertyTest } from '../src/index.js';
import { DOMAIN, fixture, REPO } from './helpers.js';

const SOURCE = `export function discount(order: { total: number; vip: boolean }): number {
  if (order.total > 1000) return 100;
  return order.vip ? 50 : 0;
}
export function head(xs: readonly number[]): number {
  return xs.length > 0 ? xs[0] : 0;
}
`;

function project(): string {
  const root = fixture();
  writeFileSync(path.join(root, 'src/order.ts'), SOURCE);

  return root;
}

function translated(exportName: string) {
  const t = translateFunction({
    file: 'src/order.ts',
    source: SOURCE,
    exportName,
    domain: DOMAIN,
    maxArrayLength: 2,
  });

  if (t.status !== 'translated') throw new Error(JSON.stringify(t));

  return t;
}

function discountIr(): PropertyIR {
  return thresholdProperty({
    implementation: translated('discount'),
    param: 'order__total',
    operator: '>=',
    value: '1000',
    whenTrue: '100',
    domain: DOMAIN,
  });
}

/** head(xs) equals xs[0] for a non-empty array and 0 otherwise, written over the flattened parameters. */
function headIr(): PropertyIR {
  const t = translated('head');
  const v = (name: string) => ({ kind: 'var' as const, name });

  return {
    irVersion: 1,
    params: t.params,
    preconditions: [],
    functions: [t.model],
    body: {
      kind: 'binary',
      op: '==',
      left: { kind: 'call', fn: 'head', args: t.params.map((p) => v(p.name)) },
      right: {
        kind: 'ite',
        cond: { kind: 'binary', op: '>', left: v('xs__length'), right: { kind: 'int', value: '0' } },
        whenTrue: v('xs__0'),
        whenFalse: { kind: 'int', value: '0' },
      },
    },
  };
}

describe('property-based tests over records and arrays', () => {
  it('calls the function with a rebuilt record and finds the seeded boundary counterexample', async () => {
    const root = project();
    const result = await runPropertyTest({
      root,
      propertyId: 'P-order',
      ir: discountIr(),
      bindings: [
        { modelName: 'discount', modulePath: path.join(root, 'src/order.ts'), exportName: 'discount' },
      ],
      seed: 7,
      numRuns: 300,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status).toBe('counterexample');
    expect(result.counterexample?.order__total).toBe('1000');
    expect(result.failure).toMatchObject({ reason: 'property_violated', expected: '100' });
  }, 60_000);

  it('passes arrays of the generated length, so a correct function is not falsified', async () => {
    const root = project();
    const result = await runPropertyTest({
      root,
      propertyId: 'P-head',
      ir: headIr(),
      bindings: [{ modelName: 'head', modulePath: path.join(root, 'src/order.ts'), exportName: 'head' }],
      seed: 7,
      numRuns: 300,
      timeoutMs: 30_000,
      experimental: false,
    });
    expect(result.status, JSON.stringify(result.failure)).toBe('passed');
  }, 60_000);

  it('generates a Vitest file that rebuilds records and arrays and runs green or red as expected', () => {
    const root = project();
    const modules = path.join(root, 'node_modules');
    mkdirSync(modules);
    symlinkSync(
      path.join(REPO, 'fixtures/discount-boundary/node_modules/vitest'),
      path.join(modules, 'vitest'),
      'dir',
    );
    symlinkSync(
      path.join(REPO, 'packages/property-testing/node_modules/fast-check'),
      path.join(modules, 'fast-check'),
      'dir',
    );
    mkdirSync(path.join(root, 'gen'));
    const files: [string, PropertyIR, string, boolean][] = [
      ['gen/order.test.ts', discountIr(), 'discount', false],
      ['gen/head.test.ts', headIr(), 'head', true],
    ];

    for (const [file, ir, exportName] of files) {
      const source = generateTestFile({
        propertyId: `P-${exportName}`,
        ir,
        bindings: [{ modelName: exportName, importPath: '../src/order.ts', exportName }],
        seed: 7,
        numRuns: 300,
        experimental: false,
        templates: vitest.templates,
      });

      if (exportName === 'discount')
        expect(source).toContain('impl0({ "total": arg(p_order__total), "vip": p_order__vip })');
      else expect(source).toContain('impl0([arg(p_xs__0), arg(p_xs__1)].slice(0, Number(p_xs__length)))');
      writeFileSync(path.join(root, file), source);
    }

    for (const [file, , , green] of files) {
      const run = spawnSync(process.execPath, [path.join(modules, 'vitest/vitest.mjs'), 'run', file], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1' },
        timeout: 120_000,
      });
      expect(run.status === 0, `${file}\n${run.stdout}${run.stderr}`).toBe(green);
    }
  }, 180_000);
});
