import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baselineFailure, errorExcerpt, instrumentationFailures, runMutation } from '../src/index.js';
import { config, tempDir } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Real mutator stderr (paths replaced) from a project whose bundler (vite:oxc) mis-parsed instrumented code. */
const OXC_STDERR = readFileSync(path.join(HERE, 'fixtures', 'oxc-parse-error.stderr.txt'), 'utf8');
const TEST_INCLUDE = ['**/*.{test,spec}.{ts,tsx,js,mjs}', '**/__tests__/**/*.{ts,tsx,js,mjs}'];

describe('baselineFailure on a transform error', () => {
  const detail = baselineFailure(OXC_STDERR, '/repo');

  it("keeps mutator's summary and the parse error, not the middle of a stack trace", () => {
    expect(detail.startsWith('runner: vitest')).toBe(true);
    expect(detail).toContain(
      'tests fail without mutants: src/utils/__tests__/exportStyles.test.ts, src/components/__tests__/Preview.test.tsx',
    );
    expect(detail).toContain(
      'first error: src/utils/__tests__/exportStyles.test.ts: Transform failed with 5 errors:',
    );
    expect(detail).toContain('[PARSE_ERROR] HTML comments are not allowed in modules');
    expect(detail).toContain('in src/utils/exportStyles.ts at 34229..34233');
    expect(detail).not.toMatch(/^\s+at /m);
    expect(detail).not.toContain('node_modules');
  });

  it('drops terminal colors and repeated lines, and stays bounded', () => {
    expect(detail).not.toContain('\u001b');
    expect(detail.split('HTML comments are not allowed').length - 1).toBe(1);
    expect(detail.length).toBeLessThan(1200);
  });
});

describe('errorExcerpt', () => {
  it('keeps the head and the informative lines of a long output, without stack frames', () => {
    const text = [
      'Error: something broke',
      ...Array.from({ length: 40 }, (_, i) => `    at frame${i} (file:///x/node_modules/y.js:${i}:1)`),
      ...Array.from({ length: 30 }, (_, i) => `noise ${i}`),
      '  File: /p/src/a.ts',
    ].join('\n');
    const excerpt = errorExcerpt(text, 6, 400);
    expect(excerpt.split('\n')[0]).toBe('Error: something broke');
    expect(excerpt).toContain('File: /p/src/a.ts');
    expect(excerpt).not.toContain(' at frame');
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('cuts a long excerpt at the end, never at the start', () => {
    const excerpt = errorExcerpt(`Error: ${'x'.repeat(1000)}`, 5, 100);
    expect(excerpt.startsWith('Error: xxx')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(101);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('instrumentationFailures', () => {
  const root = tempDir('instr');
  mkdirSync(path.join(root, 'src', 'utils', '__tests__'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'utils', 'exportStyles.ts'), 'export {};\n');
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export {};\n');
  writeFileSync(path.join(root, 'src', 'utils', '__tests__', 'x.test.ts'), '\n');
  const opts = { testInclude: TEST_INCLUDE };

  it('names the source file of an oxc parse error in mutator output', () => {
    expect(instrumentationFailures(OXC_STDERR.replaceAll('/repo', root), root, opts)).toEqual([
      'src/utils/exportStyles.ts',
    ]);
  });

  it('reads the Plugin and File lines of a Vite transform error', () => {
    const stderr = [
      'Error: Transform failed with 1 error:',
      '[PARSE_ERROR] Unexpected token',
      '  Plugin: vite:oxc',
      `  File: ${root}/src/a.ts:12:3`,
    ].join('\n');
    expect(instrumentationFailures(stderr, root, opts)).toEqual(['src/a.ts']);
  });

  it('never names a test, a file outside the root or a missing file', () => {
    const stderr = (file: string) =>
      ['Error: Transform failed with 1 error:', '  Plugin: vite:oxc', `  File: ${file}`].join('\n');
    expect(instrumentationFailures(stderr(`${root}/src/utils/__tests__/x.test.ts`), root, opts)).toEqual([]);
    expect(instrumentationFailures(stderr('/elsewhere/src/a.ts'), root, opts)).toEqual([]);
    expect(instrumentationFailures(stderr(`${root}/src/missing.ts`), root, opts)).toEqual([]);
    expect(instrumentationFailures(stderr(`${root}/../src/a.ts`), root, opts)).toEqual([]);
  });

  it('ignores an ordinary test failure that mentions a source file', () => {
    const stderr = [
      'FAIL src/utils/__tests__/x.test.ts > adds',
      'AssertionError: expected 1 to be 2',
      ' in src/a.ts at 3..4',
      '    at src/a.ts:3:4',
      'tests fail without mutants: src/utils/__tests__/x.test.ts',
    ].join('\n');
    expect(instrumentationFailures(stderr, root, opts)).toEqual([]);
  });
});

/**
 * A stand-in CLI that fails its baseline with a parse error of src/a.ts, as Vite reports it, unless that file is
 * passed to --exclude (or always, with `alwaysFail`). It counts its runs in `runs.txt` inside the report dir.
 */
function parseErrorCli(alwaysFail: boolean): { root: string; bin: string; reportDir: string } {
  const root = tempDir('instr-stub');
  const reportDir = path.join(root, 'out');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const bin = path.join(root, 'stub-cli.js');
  writeFileSync(
    bin,
    [
      "const help = '--root --reporter json, agent --report-dir --include --exclude --config --time-budget';",
      "if (process.argv.includes('--help')) { console.log(help); process.exit(0); }",
      "const fs = require('node:fs');",
      "const dir = process.argv[process.argv.indexOf('--report-dir') + 1];",
      'fs.mkdirSync(dir, { recursive: true });',
      "fs.appendFileSync(dir + '/runs.txt', process.argv.slice(2).join(' ') + '\\n');",
      "const excluded = process.argv.some((a, i) => process.argv[i - 1] === '--exclude' && a === 'src/a.ts');",
      `if (${alwaysFail} || !excluded) {`,
      "  console.error('dry run: 1/1 test files, 1 source files');",
      "  console.error('MUTATOR 1: ' + process.cwd() + '/test/a.test.ts: Transform failed with 1 error:');",
      "  console.error('');",
      "  console.error('\\u001b[31m[PARSE_ERROR] \\u001b[0mHTML comments are not allowed in modules');",
      "  console.error(' -  in src/a.ts at 10..14');",
      "  console.error('    at transformWithOxc (file:///x/node_modules/vite/dist/node/chunks/node.js:1:1)');",
      "  console.error('tests fail without mutants: test/a.test.ts');",
      '  process.exit(4);',
      '}',
      "fs.writeFileSync(dir + '/mutation.json', JSON.stringify({ schemaVersion: '2', thresholds: { high: 80, low: 60 }, files: {} }));",
      "console.log('{}');",
    ].join('\n'),
  );
  writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');

  return { root, bin, reportDir };
}

describe('runMutation when instrumented code does not parse', () => {
  it('retries once without the file the bundler could not parse, and says so', async () => {
    const { root, bin, reportDir } = parseErrorCli(false);
    const r = await runMutation({ root, config: config(), reportDir, mutatorBin: bin });
    expect(r.status).toBe('succeeded');
    expect(r.excludedFiles).toEqual(['src/a.ts']);
    expect(r.command).toEqual(expect.arrayContaining(['--exclude', 'src/a.ts']));
    const warning = r.warnings.find((w) => w.includes('src/a.ts')) ?? '';
    expect(warning).toMatch(/left out of mutation/);
    expect(warning).toMatch(/could not parse/);
    expect(warning).toMatch(/Vite/);
    expect(readFileSync(path.join(reportDir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('reports an instrumentation failure, not failing tests, when the retry fails too', async () => {
    const { root, bin, reportDir } = parseErrorCli(true);
    const r = await runMutation({ root, config: config(), reportDir, mutatorBin: bin });
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/^instrumentation failed: /);
    expect(r.detail).toContain('src/a.ts');
    expect(r.detail).toContain('[PARSE_ERROR] HTML comments are not allowed in modules');
    expect(r.detail).toMatch(/without src\/a\.ts .*failed again/);
    expect(r.excludedFiles ?? []).toEqual([]);
    // One retry at most.
    expect(readFileSync(path.join(reportDir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(existsSync(path.join(reportDir, 'mutation.json'))).toBe(false);
  });
});
