import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectTestRunner, VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { vitestTestRunner } from '../src/index.js';

describe('vitestTestRunner', () => {
  it('is selected by the default analysis.testFramework', () => {
    const framework = VeritasConfig.parse({}).analysis.testFramework;

    expect(selectTestRunner([vitestTestRunner], framework)).toBe(vitestTestRunner);
    expect(() => selectTestRunner([], framework)).toThrow(/no test runner provider/);
  });

  it('writes the imports and assertions of generated tests', () => {
    expect(vitestTestRunner.templates(process.cwd()).imports(['it', 'describe'])).toEqual([
      "import { describe, it } from 'vitest';",
    ]);
    expect(vitestTestRunner.templates(process.cwd()).imports(['it', 'expect', 'it'])).toEqual([
      "import { expect, it } from 'vitest';",
    ]);
    expect(vitestTestRunner.templates(process.cwd()).imports([])).toEqual([]);
    expect(vitestTestRunner.templates(process.cwd()).expectToBe('f(1n)', '2n')).toBe(
      'expect(f(1n)).toBe(2n);',
    );
  });

  it('does not read a report left from before the run as its own', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-vitest-report-')));
    // A stand-in Vitest that writes no report.
    mkdirSync(path.join(dir, 'node_modules/vitest'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/vitest/vitest.mjs'), '');
    mkdirSync(path.join(dir, '.veritas/improve'), { recursive: true });
    writeFileSync(
      path.join(dir, '.veritas/improve/vitest-t.json'),
      JSON.stringify({ numPassedTests: 1, numFailedTests: 0, testResults: [] }),
    );
    const run = await vitestTestRunner.execution.run(dir, { timeoutMs: 30_000, label: 't' });
    expect(run).toMatchObject({ status: 'error' });
    expect(run.status === 'error' && run.detail).toMatch(/wrote no JSON report/);
  });

  it('refuses to write its report through a .veritas that links outside the project', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-vitest-link-')));
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-vitest-outside-')));
    mkdirSync(path.join(dir, 'node_modules/vitest'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/vitest/vitest.mjs'), '');
    // As code run in an isolated copy could leave it.
    symlinkSync(outside, path.join(dir, '.veritas'), process.platform === 'win32' ? 'junction' : 'dir');
    const run = await vitestTestRunner.execution.run(dir, { timeoutMs: 30_000, label: 't' });
    expect(run).toMatchObject({ status: 'error' });
    expect(run.status === 'error' && run.detail).toMatch(/inside the project/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses test file filters that read as options or leave the directory', async () => {
    for (const file of ['--config=evil.js', '../x.test.ts', '/abs/x.test.ts', '']) {
      const run = await vitestTestRunner.execution.run(process.cwd(), {
        timeoutMs: 1000,
        label: 't',
        files: [file],
      });

      expect(run).toEqual({ status: 'error', detail: `invalid test file: ${JSON.stringify(file)}` });
    }
  });
});
