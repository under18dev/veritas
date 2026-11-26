import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chooseTestRunner,
  detectProject,
  readPackageJson,
  scriptRunsNodeWith,
  selectTestRunner,
  testFullName,
} from '@under18dev/veritas-core';
import { jestTestRunner } from '@under18dev/veritas-test-runner-jest';
import { vitestTestRunner } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { NODE_TEST_MUTATION_UNSUPPORTED, nodeTestRunner } from '../src/index.js';

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-node-runner-')));

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
const detect = (root: string) => nodeTestRunner.detection.detect(root, readPackageJson(root));
const providers = [vitestTestRunner, jestTestRunner, nodeTestRunner];
const choose = (root: string) => chooseTestRunner(providers, root, readPackageJson(root));
const NODE_TEST_FILE = "import { test } from 'node:test';\ntest('x', () => {});\n";

describe('scriptRunsNodeWith', () => {
  it('finds node --test among the options of node, through launchers', () => {
    for (const script of [
      'node --test',
      'node --test test/',
      'node --import tsx --test',
      'node -r ts-node/register --test test/',
      'node --require=./setup.cjs --no-warnings --test',
      'node --env-file .env --test',
      'node --experimental-strip-types --test "test/**/*.test.ts"',
      'cross-env NODE_ENV=test node --test',
      'tsc -p . && node --test dist/',
      'npx node --test',
    ])
      expect(scriptRunsNodeWith(script, '--test'), script).toBe(true);
  });

  it('does not take an option of the script node runs, or a quoted one, for --test', () => {
    for (const script of [
      'node test.js --test',
      'node scripts/run.mjs --test',
      'node --no-warnings scripts/check.js --test',
      'node --enable-source-maps test.js --test',
      'node -- --test',
      'vitest run --test',
      'echo "node --test"',
      'node',
      'jest',
    ])
      expect(scriptRunsNodeWith(script, '--test'), script).toBe(false);

    expect(scriptRunsNodeWith(undefined, '--test')).toBe(false);
  });
});

describe('nodeTestRunner detection', () => {
  it('is always installed, at the version of this Node.js, and declared by no package', () => {
    const found = detect(project({ 'package.json': manifest({}) }));

    expect(found).toMatchObject({
      name: 'node_test',
      declared: false,
      installedVersion: process.versions.node,
      configFile: null,
      testScript: false,
      evidence: [],
    });
    expect(found.reason).toContain('no script runs node --test and no file imports node:test');
    expect(nodeTestRunner.detection.builtIn).toBe(true);
  });

  it('finds the test script and other scripts that run node --test', () => {
    const found = detect(
      project({
        'package.json': manifest({ scripts: { 'test:unit': 'node --test', test: 'node --test test/' } }),
      }),
    );

    expect(found.testScript).toBe(true);
    expect(found.evidence).toEqual([
      'the test script runs node --test',
      'the "test:unit" script runs node --test',
    ]);
  });

  it('finds a file importing node:test when no other runner is declared', () => {
    const root = project({ 'package.json': manifest({}), 'test/a.test.mjs': NODE_TEST_FILE });

    expect(detect(root).evidence).toEqual(['a file imports node:test']);
  });

  it('ignores files importing node:test in a project that declares another runner, and in node_modules', () => {
    expect(
      detect(
        project({
          'package.json': manifest({ devDependencies: { vitest: '5.1.1' } }),
          'test/a.test.mjs': NODE_TEST_FILE,
        }),
      ).evidence,
    ).toEqual([]);
    expect(
      detect(project({ 'package.json': manifest({}), 'node_modules/x/a.test.mjs': NODE_TEST_FILE })).evidence,
    ).toEqual([]);
  });
});

describe('choosing the Node.js test runner', () => {
  it('chooses it only on evidence, never for being built into Node.js', () => {
    expect(choose(project({ 'package.json': manifest({}) }))).toMatchObject({
      provider: { name: 'vitest' },
      ambiguous: false,
    });
    const vitest = choose(
      project({
        'package.json': manifest({ devDependencies: { vitest: '5.1.1' } }),
        ...installed('vitest', '5.1.1'),
      }),
    );

    expect(vitest).toMatchObject({ provider: { name: 'vitest' }, ambiguous: false });
    expect(vitest.reason).toMatch(/^Vitest is the only test runner found/);
  });

  it('chooses it for a project whose test script runs node --test', () => {
    const choice = choose(project({ 'package.json': manifest({ scripts: { test: 'node --test' } }) }));

    expect(choice).toMatchObject({ provider: { name: 'node_test' }, ambiguous: false });
    expect(choice.reason).toBe(
      'Node.js test runner is the only test runner found (the test script runs node --test)',
    );
  });

  it('prefers the runner the test script runs when another one is installed', () => {
    const choice = choose(
      project({
        'package.json': manifest({ scripts: { test: 'node --test' }, devDependencies: { vitest: '5.1.1' } }),
        ...installed('vitest', '5.1.1'),
      }),
    );

    expect(choice).toMatchObject({ provider: { name: 'node_test' }, ambiguous: false });
    expect(choice.reason).toContain('the test script runs Node.js test runner');
  });

  it('does not let a package importing node:test outvote an installed runner in a monorepo', () => {
    // Vitest is hoisted to the root but declared only by packages/a; packages/b runs node --test.
    const root = project({
      'package.json': manifest({
        private: true,
        workspaces: ['packages/*'],
        scripts: { test: 'pnpm -r test' },
      }),
      ...installed('vitest', '5.1.1'),
      'packages/a/package.json': manifest({
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '5.1.1' },
      }),
      'packages/a/src/a.test.ts': "import { it } from 'vitest';\nit('a', () => {});\n",
      'packages/b/package.json': manifest({ scripts: { test: 'node --test' } }),
      'packages/b/test/b.test.mjs': NODE_TEST_FILE,
    });
    const choice = choose(root);

    expect(detect(root)).toMatchObject({ evidence: ['a file imports node:test'], importsOnly: true });
    expect(choice).toMatchObject({ provider: { name: 'vitest' }, ambiguous: true });
    expect(choice.candidates.map((runner) => runner.name)).toEqual(['vitest', 'node_test']);
    expect(choice.reason).toContain('nothing tells them apart');
  });

  it('decides on a script that runs node --test, saying so', () => {
    const choice = choose(
      project({
        'package.json': manifest({ scripts: { 'test:node': 'node --test' } }),
        ...installed('vitest', '5.1.1'),
      }),
    );

    expect(choice).toMatchObject({ provider: { name: 'node_test' }, ambiguous: false });
    expect(choice.reason).toBe(
      'Vitest and Node.js test runner are installed; only Node.js test runner has a config file, a dependency or a script that runs it (the "test:node" script runs node --test); Vitest also shows up (installed, with nothing in package.json or config files)',
    );
  });

  it('is selected by analysis.testFramework "node_test"', () => {
    expect(selectTestRunner(providers, 'node_test')).toBe(nodeTestRunner);
  });

  it('proposes Node default test file patterns that a file using node:test matches', () => {
    const root = project({
      'package.json': manifest({ scripts: { test: 'node --test' } }),
      'test/pricing.mjs': NODE_TEST_FILE,
      'lib/math-test.js': NODE_TEST_FILE,
      'lib/util_test.ts': 'export const helper = 1;\n',
    });

    expect(detectProject(root, nodeTestRunner).testGlobs).toEqual([
      '**/*.{test,spec}.{ts,tsx,js,mjs}',
      '**/*-test.{ts,mts,cts,js,mjs,cjs}',
      '**/test/**/*.{ts,mts,cts,js,mjs,cjs}',
    ]);
  });
});

describe('nodeTestRunner API', () => {
  it('names node:test, its options objects, hooks and mock API, and node:assert', () => {
    const { recognition } = nodeTestRunner;

    expect(recognition.modules).toEqual(['node:test']);
    expect(recognition.defaultExport).toBe('test');
    expect(recognition.tests).toEqual(['test', 'it']);
    expect(recognition.suites).toEqual(['describe', 'suite']);
    expect(recognition.testOptions).toBe(true);
    expect(recognition.hooks).toEqual({
      beforeEach: ['beforeEach'],
      beforeAll: ['before'],
      afterEach: ['afterEach'],
      afterAll: ['after'],
    });
    expect(recognition.assertions.modules).toEqual([
      'node:assert',
      'node:assert/strict',
      'assert',
      'assert/strict',
    ]);
    expect(recognition.mocks.calls).toMatchObject({ fn: 'create', method: 'spy', module: 'module_late' });
    expect(nodeTestRunner.recognitionFor('/nowhere')).toBe(recognition);
  });

  it('keys tests by suite and test titles joined with " > "', () => {
    expect(testFullName(nodeTestRunner, ['pricing', 'discount'], 'at 1000')).toBe(
      'pricing > discount > at 1000',
    );
  });

  it('generates tests with node:test and node:assert/strict, importing the source file', () => {
    const templates = nodeTestRunner.templates('/nowhere');

    expect(templates.imports(['expect', 'it'])).toEqual([
      "import assert from 'node:assert/strict';",
      "import { it } from 'node:test';",
    ]);
    expect(templates.imports(['describe', 'it'])).toEqual(["import { describe, it } from 'node:test';"]);
    expect(templates.imports([])).toEqual([]);
    expect(templates.expectToBe('f(1)', 'true')).toBe('assert.strictEqual(f(1), true);');
    expect(templates.sourceImports).toBe(true);
  });

  it('reports mutation testing as unsupported, with the reason, and writes no mutator config', () => {
    const { mutation } = nodeTestRunner;

    expect(mutation.mutatorRunner).toBeNull();
    expect(mutation.unsupportedReason('/nowhere')).toBe(NODE_TEST_MUTATION_UNSUPPORTED);
    expect(NODE_TEST_MUTATION_UNSUPPORTED).toContain('meaningful_with_evidence');
    expect(() => mutation.writeConfig({ root: '/nowhere', dir: '/nowhere', allowDirs: [] })).toThrow(
      /cannot run tests written for the Node.js test runner/,
    );
  });
});
