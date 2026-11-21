import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeMutationJestConfig } from '../src/mutation-config.js';
import { copyJestFixture, FIXTURE } from './helpers.js';

const JEST_BIN = path.join(FIXTURE, 'node_modules', 'jest', 'bin', 'jest.js');
const copyFixture = () => copyJestFixture('jest-config');

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
    .map((file) =>
      path.relative(realpathSync.native(root), realpathSync.native(file)).split(path.sep).join('/'),
    )
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

  it("reads a TypeScript config the way Jest does, and fails with Jest's own message when Jest cannot", () => {
    const root = copyFixture();
    rmSync(path.join(root, 'jest.config.mjs'));
    // Type annotations only: Node strips them, as Jest does when it loads the config.
    writeFileSync(
      path.join(root, 'jest.config.ts'),
      [
        'const config: { transform: Record<string, string>; testMatch: string[] } = {',
        '  transform: {},',
        "  testMatch: ['**/test/*-weak.test.ts'],",
        '};',
        'export default config;',
      ].join('\n'),
    );
    const dir = path.join(root, '.veritas', 'ts');
    mkdirSync(dir, { recursive: true });

    expect(
      listTests(root, writeMutationJestConfig({ root, dir, testFiles: ['test/discount-weak.test.ts'] })),
    ).toEqual(['test/discount-weak.test.ts']);
    // `export =` needs a TypeScript loader; without ts-node, Jest itself cannot read the config, and says so.
    rmSync(path.join(root, 'jest.config.ts'));
    writeFileSync(
      path.join(root, 'jest.config.cts'),
      'const config = { transform: {} };\nexport = config;\n',
    );
    const failed = spawnSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        JEST_BIN,
        '--config',
        writeMutationJestConfig({ root, dir }),
        '--listTests',
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );

    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('Failed to parse the TypeScript config file');
  });
});
