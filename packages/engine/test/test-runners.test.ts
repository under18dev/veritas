import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  detectProject,
  initProject,
  TEST_RUNNERS,
  testRunnerFor,
  testRunnerForProject,
} from '../src/index.js';

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-engine-runners-')));

  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }

  return root;
}

const jestProject = () =>
  project({
    'package.json': JSON.stringify({
      type: 'module',
      scripts: { test: 'jest' },
      devDependencies: { jest: '30.5.2' },
    }),
    'node_modules/jest/package.json': JSON.stringify({ name: 'jest', version: '30.5.2' }),
    'jest.config.mjs': 'export default {};',
  });

describe('test runner selection in the engine', () => {
  it('brings Vitest, the default, Jest and the Node.js test runner', () => {
    expect(TEST_RUNNERS.map((runner) => runner.name)).toEqual(['vitest', 'jest', 'node_test']);
    expect(testRunnerFor(null).name).toBe('vitest');
    // A configuration written before testFramework had more than one value still means Vitest.
    expect(testRunnerFor(VeritasConfig.parse({})).name).toBe('vitest');
    expect(testRunnerFor(VeritasConfig.parse({ analysis: { testFramework: 'jest' } })).name).toBe('jest');
    expect(testRunnerFor(VeritasConfig.parse({ analysis: { testFramework: 'node_test' } })).name).toBe(
      'node_test',
    );
  });

  it('detects the runner of a project without a configuration, and keeps a configured one', () => {
    const root = jestProject();

    expect(testRunnerForProject(root, null).name).toBe('jest');
    expect(detectProject(root).testRunner).toMatchObject({ name: 'jest', installedVersion: '30.5.2' });
    expect(testRunnerForProject(root, VeritasConfig.parse({})).name).toBe('vitest');
  });

  it('writes the detected runner to analysis.testFramework and says why', () => {
    const root = jestProject();
    const result = initProject(root);

    expect(result.testRunner).toEqual({
      name: 'jest',
      reason:
        'Jest is the only test runner found (jest.config.mjs, the test script runs jest, jest in package.json)',
      ambiguous: false,
    });
    expect(JSON.parse(readFileSync(result.file, 'utf8')).analysis.testFramework).toBe('jest');
  });

  it('flags an init that could not tell the runners apart, unless the user chose', () => {
    const root = project({
      'package.json': JSON.stringify({ devDependencies: { jest: '30', vitest: '5' } }),
    });
    const ambiguous = initProject(root, { dryRun: true });

    expect(ambiguous.testRunner).toMatchObject({ name: 'vitest', ambiguous: true });
    expect(ambiguous.nextSteps[0]).toContain('check analysis.testFramework');
    const chosen = initProject(root, {
      dryRun: true,
      config: VeritasConfig.parse({ analysis: { testFramework: 'jest' } }),
      testRunnerConfirmed: true,
    });

    expect(chosen.testRunner).toEqual({
      name: 'jest',
      reason: 'more than one test runner was found; Jest was chosen when asked',
      ambiguous: false,
    });
  });

  it('sets up a project whose test script runs node --test for the Node.js test runner', () => {
    const root = project({
      'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
      'test/a.test.mjs': "import { test } from 'node:test';\ntest('a', () => {});\n",
    });
    const result = initProject(root, { dryRun: true });

    expect(result.testRunner).toEqual({
      name: 'node_test',
      reason:
        'Node.js test runner is the only test runner found (the test script runs node --test, a file imports node:test)',
      ambiguous: false,
    });
    expect(result.config.analysis.testFramework).toBe('node_test');
    expect(result.project.testRunner.installedVersion).toBe(process.versions.node);
  });

  it('never chooses the Node.js test runner only because Node.js has it', () => {
    const root = project({ 'package.json': JSON.stringify({ devDependencies: { vitest: '5' } }) });

    expect(initProject(root, { dryRun: true }).testRunner).toMatchObject({
      name: 'vitest',
      ambiguous: false,
    });
    // Configured explicitly, it needs nothing installed.
    expect(
      initProject(root, {
        dryRun: true,
        config: VeritasConfig.parse({ analysis: { testFramework: 'node_test' } }),
      }).testRunner.name,
    ).toBe('node_test');
  });

  it('reports JEST_NOT_FOUND when the configuration names Jest and the project lacks it', () => {
    const root = project({ 'package.json': JSON.stringify({ devDependencies: { vitest: '5' } }) });

    expect(() =>
      initProject(root, { config: VeritasConfig.parse({ analysis: { testFramework: 'jest' } }) }),
    ).toThrow(expect.objectContaining({ code: 'JEST_NOT_FOUND' }));
  });
});
