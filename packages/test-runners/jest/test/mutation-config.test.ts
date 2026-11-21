import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { writeMutationJestConfig } from '../src/mutation-config.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/jest-app');
const JEST_BIN = path.join(FIXTURE, 'node_modules', 'jest', 'bin', 'jest.js');

function copyFixture(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-jest-config-')));
  cpSync(FIXTURE, root, { recursive: true, filter: (src) => !src.includes('node_modules') });
  symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(root, 'node_modules'), 'junction');

  return root;
}

/** The test files Jest selects with `config`, relative to `root` (POSIX), as `jest --listTests` prints them. */
function listTests(root: string, config: string): string[] {
  const listed = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--disable-warning=ExperimentalWarning',
      JEST_BIN,
      '--config',
      config,
      '--listTests',
      '--json',
    ],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
  expect(listed.status, listed.stderr).toBe(0);

  return (JSON.parse(listed.stdout.slice(listed.stdout.indexOf('['))) as string[])
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .sort();
}

describe.skipIf(!existsSync(JEST_BIN))('writeMutationJestConfig', () => {
  it('keeps the project config and limits it to the given test files', () => {
    const root = copyFixture();
    const dir = (name: string) => {
      const at = path.join(root, '.veritas', 'runs', name, 'mutation');
      mkdirSync(at, { recursive: true });

      return at;
    };
    const some = writeMutationJestConfig({
      root,
      dir: dir('some'),
      testFiles: ['test/discount-weak.test.ts'],
    });

    expect(path.basename(some)).toBe('jest.mutation.config.mjs');
    expect(listTests(root, some)).toEqual(['test/discount-weak.test.ts']);
    expect(listTests(root, writeMutationJestConfig({ root, dir: dir('all') }))).toEqual([
      'test/checkout-mocks.test.ts',
      'test/discount-weak.test.ts',
      'test/shipping-boundary.test.ts',
      'test/tautological.test.ts',
    ]);
  });

  it('reads the "jest" key of package.json when there is no config file', () => {
    const root = copyFixture();
    rmSync(path.join(root, 'jest.config.mjs'));
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ type: 'module', jest: { testMatch: ['**/test/*-weak.test.ts'], transform: {} } }),
    );
    const dir = path.join(root, '.veritas', 'm');
    mkdirSync(dir, { recursive: true });

    expect(listTests(root, writeMutationJestConfig({ root, dir }))).toEqual(['test/discount-weak.test.ts']);
    expect(
      listTests(root, writeMutationJestConfig({ root, dir, testFiles: ['test/shipping-boundary.test.ts'] })),
    ).toEqual(['test/shipping-boundary.test.ts']);
  });
});
