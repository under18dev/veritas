import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { vitestTestRunner } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { generateTestFile } from '../src/index.js';
import { DOMAIN, discountProperty, fixture, REPO } from './helpers.js';

const SEED = 20251119;

function generated(root: string, file: string, experimental: boolean, importPath: string): string {
  const { ir } = discountProperty(root, file);

  return generateTestFile({
    propertyId: 'P-discount-threshold',
    ir,
    bindings: [{ modelName: 'discountAmount', importPath, exportName: 'discountAmount' }],
    seed: SEED,
    numRuns: 200,
    experimental,
    templates: vitestTestRunner.templates(process.cwd()),
  });
}

/** A temp project where vitest (from the fixture install) and fast-check (ours) resolve. */
function project(): string {
  const root = fixture();
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

  return root;
}

function vitest(root: string, file: string) {
  return spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', file], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1' },
    timeout: 120_000,
  });
}

describe('generateTestFile', () => {
  it('encodes seed, numRuns, domains, fast-check and the non-proof disclaimer', () => {
    const root = fixture();
    const source = generated(root, 'src/pricing.ts', false, '../src/pricing.ts');
    expect(source).toContain("import * as fc from 'fast-check';");
    expect(source).toContain(`seed: ${SEED}, numRuns: 200`);
    expect(source).toContain(`fc.integer({ min: ${DOMAIN.min}, max: ${DOMAIN.max} })`);
    expect(source).toContain(`//   total: integer in [${DOMAIN.min}, ${DOMAIN.max}]`);
    expect(source).toMatch(/empirical evidence, not a proof/);
    expect(source).toContain('import { discountAmount as impl0 } from "../src/pricing.ts";');
    expect(source).not.toContain('[experimental]');
  });

  it('marks experimental properties in the test name', () => {
    const root = fixture();
    const source = generated(root, 'src/pricing.ts', true, '../src/pricing.ts');
    expect(source).toContain('it("[experimental] P-discount-threshold holds for 200 sampled inputs');
    expect(source).toMatch(/EXPERIMENTAL/);
  });

  it('is deterministic and never writes a file', () => {
    const root = fixture();
    const a = generated(root, 'src/pricing.ts', false, '../src/pricing.ts');
    const b = generated(root, 'src/pricing.ts', false, '../src/pricing.ts');
    expect(a).toBe(b);
    expect(existsSync(path.join(root, 'test/generated.test.ts'))).toBe(false);
  });

  it('rejects identifiers that would inject code and keeps comments single-line', () => {
    const root = fixture();
    const { ir } = discountProperty(root, 'src/pricing.ts');
    expect(() =>
      generateTestFile({
        propertyId: 'P',
        ir,
        bindings: [
          { modelName: 'discountAmount', importPath: '../src/pricing.ts', exportName: 'x }; evil(); {' },
        ],
        seed: 1,
        numRuns: 1,
        experimental: false,
        templates: vitestTestRunner.templates(process.cwd()),
      }),
    ).toThrow(/not a valid identifier/);
    const source = generateTestFile({
      propertyId: 'P\nprocess.exit(1)',
      ir,
      bindings: [
        { modelName: 'discountAmount', importPath: '../src/pricing.ts', exportName: 'discountAmount' },
      ],
      seed: 1,
      numRuns: 1,
      experimental: false,
      templates: vitestTestRunner.templates(process.cwd()),
    });
    expect(source.split('\n').some((l) => l.startsWith('process.exit'))).toBe(false);
  });

  it('fails under vitest for the broken implementation and passes for the fixed one', () => {
    const root = project();
    writeFileSync(
      path.join(root, 'test/broken.generated.test.ts'),
      generated(root, 'src/pricing.ts', false, '../src/pricing.ts'),
    );
    writeFileSync(
      path.join(root, 'test/fixed.generated.test.ts'),
      generated(root, 'candidates/pricing-fixed.ts', true, '../candidates/pricing-fixed.ts'),
    );
    const broken = vitest(root, 'test/broken.generated.test.ts');
    const brokenOutput = broken.stdout + broken.stderr;
    expect(broken.status, brokenOutput).toBe(1);
    expect(brokenOutput).toMatch(/Property failed after \d+ tests/);
    expect(brokenOutput).toMatch(/Counterexample: \[\{"total":1000\}\]/);
    expect(brokenOutput).toContain(`seed: ${SEED}`);

    const fixed = vitest(root, 'test/fixed.generated.test.ts');
    const fixedOutput = fixed.stdout + fixed.stderr;
    expect(fixed.status, fixedOutput).toBe(0);
    expect(fixedOutput).toMatch(/1 passed/);
  }, 180_000);
});
