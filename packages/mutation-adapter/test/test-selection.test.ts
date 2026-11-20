import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMutatorArgs, rootTsconfigHasNoFiles, runMutation } from '../src/index.js';
import { writeNarrowedVitestConfig } from '../src/vitest-config.js';
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

describe('writeNarrowedVitestConfig', () => {
  const vitestBin = path.join(
    path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
    'vitest.mjs',
  );
  const listFiles = (root: string, configPath: string): string[] => {
    const listed = spawnSync(process.execPath, [vitestBin, 'list', '--filesOnly', '--config', configPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(listed.status, listed.stderr).toBe(0);

    return listed.stdout
      .split('\n')
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
      .filter(Boolean)
      .sort();
  };

  it('keeps only the selected tests in the project config and drops projects left without one', () => {
    const root = tempDir('narrow');
    write(root, {
      'vitest.config.mjs': `export default {
        test: {
          globals: true,
          projects: [
            { test: { name: 'unit', globals: true, include: ['packages/*/test/**/*.test.mjs'] } },
            { test: { name: 'acceptance', globals: true, include: ['test/acceptance/**/*.test.mjs'] } },
          ],
        },
      };`,
      'packages/a/test/a.test.mjs': "it('a', () => {});",
      'packages/b/test/b.test.mjs': "it('b', () => {});",
      'test/acceptance/slow.test.mjs': "it('slow', () => {});",
    });
    const dir = path.join(root, '.veritas/runs/r/mutation');
    mkdirSync(dir, { recursive: true });
    const configPath = writeNarrowedVitestConfig({ root, dir, testFiles: ['packages/a/test/a.test.mjs'] });
    expect(listFiles(root, configPath)).toEqual(['packages/a/test/a.test.mjs']);
  }, 90_000);

  it('works without a project config', () => {
    const root = tempDir('bare');
    write(root, {
      'test/a.test.mjs': "import { it } from 'vitest'; it('a', () => {});",
      'test/b.test.mjs': "import { it } from 'vitest'; it('b', () => {});",
    });
    const dir = path.join(root, '.veritas/runs/r/mutation');
    mkdirSync(dir, { recursive: true });
    const configPath = writeNarrowedVitestConfig({ root, dir, testFiles: ['test/b.test.mjs'] });
    expect(readFileSync(configPath, 'utf8')).toContain('const baseModule = {};');
    expect(listFiles(root, configPath)).toEqual(['test/b.test.mjs']);
  }, 90_000);
});
