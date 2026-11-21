import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chooseTestRunner,
  readPackageJson,
  scriptRuns,
  selectTestRunner,
  testFullName,
} from '@under18dev/veritas-core';
import { vitestTestRunner } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { jestTestRunner } from '../src/index.js';

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-jest-runner-')));

  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }

  return root;
}

const manifest = (fields: Record<string, unknown>) => JSON.stringify({ name: 'p', ...fields });
const installed = (name: string, version: string) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, version }),
});
const detect = (root: string) => jestTestRunner.detection.detect(root, readPackageJson(root));
const providers = [vitestTestRunner, jestTestRunner];

describe('jestTestRunner detection', () => {
  it('finds Jest through its config file', () => {
    for (const file of [
      'jest.config.js',
      'jest.config.ts',
      'jest.config.mjs',
      'jest.config.cjs',
      'jest.config.json',
    ]) {
      const root = project({ 'package.json': manifest({}), [file]: '{}' });

      expect(detect(root)).toMatchObject({
        name: 'jest',
        configFile: file,
        evidence: [file],
        declared: false,
      });
    }
  });

  it('finds Jest through a "jest" key, a dependency or the test script', () => {
    expect(
      detect(project({ 'package.json': manifest({ jest: { testEnvironment: 'node' } }) })).evidence,
    ).toEqual(['a "jest" key in package.json']);
    expect(
      detect(
        project({
          'package.json': manifest({ devDependencies: { jest: '30.5.2' } }),
          ...installed('jest', '30.5.2'),
        }),
      ),
    ).toMatchObject({ declared: true, installedVersion: '30.5.2', evidence: ['jest in package.json'] });

    for (const script of [
      'jest',
      'jest --coverage',
      'NODE_OPTIONS=--experimental-vm-modules npx jest',
      'node --experimental-vm-modules node_modules/jest/bin/jest.js',
      'tsc && jest',
    ]) {
      const found = detect(project({ 'package.json': manifest({ scripts: { test: script } }) }));

      expect(found.testScript, script).toBe(true);
      expect(found.evidence).toEqual(['the test script runs jest']);
    }
  });

  it('does not take ts-jest, jest-cli or an installed copy alone for evidence', () => {
    expect(scriptRuns('ts-jest', ['jest'])).toBe(false);
    expect(scriptRuns('jest-cli --x', ['jest'])).toBe(false);
    expect(scriptRuns('vitest run', ['jest'])).toBe(false);
    const root = project({ 'package.json': manifest({}), ...installed('jest', '29.7.0') });

    expect(detect(root)).toMatchObject({ installedVersion: '29.7.0', evidence: [] });
    expect(detect(root).reason).toContain('jest 29.7.0 is installed');
  });
});

describe('choosing the runner', () => {
  it('chooses the only runner found, and says why', () => {
    const root = project({
      'package.json': manifest({ devDependencies: { jest: '30' } }),
      'jest.config.mjs': '',
    });
    const choice = chooseTestRunner(providers, root, readPackageJson(root));

    expect(choice.provider).toBe(jestTestRunner);
    expect(choice.ambiguous).toBe(false);
    expect(choice.reason).toBe('Jest is the only test runner found (jest.config.mjs, jest in package.json)');
  });

  it('prefers the runner the test script runs when both are present', () => {
    const root = project({
      'package.json': manifest({ scripts: { test: 'jest' }, devDependencies: { jest: '30', vitest: '5' } }),
    });
    const choice = chooseTestRunner(providers, root, readPackageJson(root));

    expect(choice.provider).toBe(jestTestRunner);
    expect(choice.ambiguous).toBe(false);
    expect(choice.reason).toContain('the test script runs Jest');
  });

  it('marks the choice ambiguous when the test script does not tell them apart', () => {
    const root = project({
      'package.json': manifest({
        scripts: { test: 'npm run unit' },
        devDependencies: { jest: '30', vitest: '5' },
      }),
    });
    const choice = chooseTestRunner(providers, root, readPackageJson(root));

    expect(choice.provider).toBe(vitestTestRunner);
    expect(choice.ambiguous).toBe(true);
    expect(choice.reason).toContain('set analysis.testFramework');
  });

  it('falls back to installed runners, then to the default with nothing found', () => {
    const installedOnly = project({ 'package.json': manifest({}), ...installed('jest', '30.5.2') });

    expect(chooseTestRunner(providers, installedOnly, readPackageJson(installedOnly)).provider).toBe(
      jestTestRunner,
    );
    const empty = project({ 'package.json': manifest({}) });
    const none = chooseTestRunner(providers, empty, readPackageJson(empty));

    expect(none.provider).toBe(vitestTestRunner);
    expect(none.reason).toBe('no supported test runner (Vitest, Jest) was found');
  });

  it('does not count a Vite config as Vitest evidence', () => {
    const root = project({
      'package.json': manifest({ devDependencies: { jest: '30' } }),
      'vite.config.ts': 'export default {}',
    });

    expect(chooseTestRunner(providers, root, readPackageJson(root)).provider).toBe(jestTestRunner);
  });
});

describe('jestTestRunner', () => {
  it('is selected by analysis.testFramework "jest"', () => {
    expect(selectTestRunner(providers, 'jest')).toBe(jestTestRunner);
  });

  it('names tests the way Jest reports them', () => {
    expect(testFullName(jestTestRunner, ['shippingFee', 'at the threshold'], 'ships free')).toBe(
      'shippingFee at the threshold ships free',
    );
    expect(testFullName(vitestTestRunner, ['a', 'b'], 'c')).toBe('a > b > c');
  });

  it('imports from @jest/globals only when the project has it', () => {
    const withGlobals = project({ 'package.json': manifest({}), ...installed('@jest/globals', '30.5.2') });
    const without = project({ 'package.json': manifest({}) });

    expect(jestTestRunner.templates(withGlobals).imports(['it', 'expect', 'it'])).toEqual([
      "import { expect, it } from '@jest/globals';",
    ]);
    expect(jestTestRunner.templates(withGlobals).imports([])).toEqual([]);
    expect(jestTestRunner.templates(without).imports(['describe', 'it'])).toEqual([]);
    expect(jestTestRunner.templates(without).expectToBe('f(1n)', '2n')).toBe('expect(f(1n)).toBe(2n);');
  });

  it('says why mutation cannot run outside native ESM projects or with Jest projects', () => {
    expect(jestTestRunner.mutation.unsupportedReason(project({ 'package.json': manifest({}) }))).toMatch(
      /native ESM projects/,
    );
    expect(
      jestTestRunner.mutation.unsupportedReason(
        project({ 'package.json': manifest({ type: 'module', jest: { projects: ['a'] } }) }),
      ),
    ).toMatch(/projects/);
    expect(
      jestTestRunner.mutation.unsupportedReason(
        project({ 'package.json': manifest({ type: 'module' }), 'jest.config.json': '{"projects":["a"]}' }),
      ),
    ).toMatch(/projects/);
    expect(
      jestTestRunner.mutation.unsupportedReason(project({ 'package.json': manifest({ type: 'module' }) })),
    ).toBe(null);
  });

  it('refuses test file filters that read as options or leave the directory', async () => {
    const root = project({ 'package.json': manifest({}), 'node_modules/jest/bin/jest.js': '' });

    for (const file of ['--config=evil.js', '../x.test.ts', '/abs/x.test.ts', '']) {
      const run = await jestTestRunner.execution.run(root, { timeoutMs: 1000, label: 't', files: [file] });

      expect(run).toEqual({ status: 'error', detail: `invalid test file: ${JSON.stringify(file)}` });
    }
  });

  it('reports a project without Jest installed', async () => {
    const run = await jestTestRunner.execution.run(project({ 'package.json': manifest({}) }), {
      timeoutMs: 1000,
      label: 't',
    });

    expect(run).toEqual({ status: 'error', detail: 'jest is not installed in the project' });
  });
});
