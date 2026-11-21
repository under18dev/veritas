import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselineFailure } from '../src/diagnose.js';
import { buildMutatorArgs, rootTsconfigHasNoFiles, runMutation } from '../src/index.js';
import { config, tempDir } from './helpers.js';

function write(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
}

/** A stand-in mutator that records its arguments and writes an empty report. */
function recordingCli(root: string): string {
  const bin = path.join(root, 'stub-cli.js');
  write(root, {
    'package.json': '{"type":"commonjs"}',
    'stub-cli.js': [
      "const help = '--root --reporter json, agent --report-dir --include --config --[no-]typecheck --time-budget';",
      "if (process.argv.includes('--help')) { console.log(help); process.exit(0); }",
      "const fs = require('node:fs');",
      "const dir = process.argv[process.argv.indexOf('--report-dir') + 1];",
      `fs.writeFileSync(${JSON.stringify(path.join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));`,
      "fs.writeFileSync(dir + '/mutation.json', JSON.stringify({ schemaVersion: '2', thresholds: { high: 80, low: 60 }, files: {} }));",
      "console.log('{}');",
    ].join('\n'),
  });

  return bin;
}

describe('test selection for mutator', () => {
  it('passes --config and --no-typecheck before the time budget', () => {
    const args = buildMutatorArgs({
      root: '/p',
      config: config({ timeoutMs: 60_000 }),
      reportDir: '/p/.veritas/runs/r/mutation',
      configPath: '/p/.veritas/runs/r/mutation/vitest.mutation.config.mjs',
      noTypecheck: true,
    });
    expect(args.slice(-5)).toEqual([
      '--config',
      '/p/.veritas/runs/r/mutation/vitest.mutation.config.mjs',
      '--no-typecheck',
      '--time-budget',
      '45',
    ]);
  });

  it('does not start mutator when no test imports the code in scope', async () => {
    const root = tempDir('no-tests');
    const bin = recordingCli(root);
    const result = await runMutation({
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
      testFiles: [],
    });
    expect(result).toMatchObject({ status: 'succeeded', mutants: [] });
    expect(result.warnings).toContain('no test imports the code in scope; mutation was not run');
    expect(existsSync(path.join(root, 'argv.json'))).toBe(false);
  });

  it('runs mutator with a generated Vitest config limited to the given tests', async () => {
    const root = tempDir('selected');
    const bin = recordingCli(root);
    const reportDir = path.join(root, 'out');
    const result = await runMutation({
      root,
      config: config(),
      reportDir,
      mutatorBin: bin,
      testFiles: ['test/a.test.ts'],
    });
    expect(result.status).toBe('succeeded');
    const argv = JSON.parse(readFileSync(path.join(root, 'argv.json'), 'utf8')) as string[];
    const configPath = argv[argv.indexOf('--config') + 1] as string;
    expect(configPath).toBe(path.join(reportDir, 'vitest.mutation.config.mjs'));
    expect(readFileSync(configPath, 'utf8')).toContain(JSON.stringify(path.join(root, 'test/a.test.ts')));
  });
});

describe('rootTsconfigHasNoFiles', () => {
  it('recognises a root tsconfig that only references other projects, comments and trailing commas included', () => {
    const root = tempDir('solution');
    write(root, {
      'tsconfig.json': '{\n  // solution\n  "files": [],\n  "references": [{ "path": "packages/a" },],\n}\n',
    });
    expect(rootTsconfigHasNoFiles(root)).toBe(true);
  });

  it('is false for an ordinary, extended or missing tsconfig', () => {
    const ordinary = tempDir('ordinary');
    write(ordinary, { 'tsconfig.json': '{ "include": ["src"] }' });
    const extended = tempDir('extended');
    write(extended, {
      'tsconfig.json': '{ "extends": "./base.json", "files": [], "references": [{ "path": "a" }] }',
    });
    expect(rootTsconfigHasNoFiles(ordinary)).toBe(false);
    expect(rootTsconfigHasNoFiles(extended)).toBe(false);
    expect(rootTsconfigHasNoFiles(tempDir('missing'))).toBe(false);
  });
});

describe('baselineFailure', () => {
  it('names the first reason a test file failed to load, without the debug output and stack traces', () => {
    const stderr = [
      'runner: vitest',
      'dry run: 2/9 test files, 1 source files',
      "MUTATOR 12: /p/src/a.test.ts: Cannot find module '/@fs/opt/veritas/setup.js'",
      "Error: Cannot find module '/@fs/opt/veritas/setup.js'",
      '    at reviveInvokeError (file:///p/node_modules/vite/module-runner.js:1:1)',
      "MUTATOR 12: /p/src/b.test.ts: Cannot find module '/@fs/opt/veritas/setup.js'",
      '    at reviveInvokeError (file:///p/node_modules/vite/module-runner.js:1:1)',
      'tests fail without mutants: src/a.test.ts, src/b.test.ts',
    ].join('\n');
    const detail = baselineFailure(stderr, '/p');
    expect(detail).toBe(
      [
        'runner: vitest',
        'dry run: 2/9 test files, 1 source files',
        'tests fail without mutants: src/a.test.ts, src/b.test.ts',
        "first error: src/a.test.ts: Cannot find module '/@fs/opt/veritas/setup.js'",
      ].join('\n'),
    );
    expect(baselineFailure('tests fail without mutants: a.test.ts', '/p')).toBe(
      'tests fail without mutants: a.test.ts',
    );
  });
});
