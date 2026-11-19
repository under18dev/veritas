import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VeritasError } from '@veritas/core';
import { describe, expect, it } from 'vitest';
import { importMutationReport, mutatorTestRef, runMutation, shellQuote } from '../src/index.js';
import { config, tempDir } from './helpers.js';

const PRIVATE_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdefghijklmnop\n-----END RSA PRIVATE KEY-----';

/** A stand-in CLI that advertises the real flags and records that it was spawned. */
function stubCli(body: string): { root: string; bin: string; marker: string } {
  const root = tempDir('review-stub');
  const bin = path.join(root, 'stub-cli.js');
  const marker = path.join(root, 'spawned');
  writeFileSync(
    bin,
    [
      "const help = '--root --reporter json, agent --report-dir --since --include --kill-matrix --only --time-budget';",
      "if (process.argv.includes('--help')) { console.log(help); process.exit(0); }",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
      "const dir = process.argv[process.argv.indexOf('--report-dir') + 1];",
      body,
    ].join('\n'),
  );
  writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');
  return { root, bin, marker };
}

describe('runMutation confines reportDir to the project root', () => {
  it('rejects a reportDir outside the root before creating it or spawning the mutator', async () => {
    const { root, bin, marker } = stubCli("console.log('{}');");
    const outside = path.join(tempDir('review-outside'), 'veritas-outside');
    const run = runMutation({ root, config: config(), reportDir: outside, mutatorBin: bin });
    await expect(run).rejects.toBeInstanceOf(VeritasError);
    await expect(run).rejects.toMatchObject({ code: 'REPORT_DIR_OUTSIDE_ROOT' });
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects traversal out of the root and the root itself', async () => {
    const { root, bin, marker } = stubCli("console.log('{}');");
    for (const reportDir of [path.join(root, '..', 'escape'), root]) {
      await expect(runMutation({ root, config: config(), reportDir, mutatorBin: bin })).rejects.toMatchObject(
        {
          code: 'REPORT_DIR_OUTSIDE_ROOT',
        },
      );
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects a reportDir reached through a symlink that points outside the root', async () => {
    const { root, bin, marker } = stubCli("console.log('{}');");
    const target = tempDir('review-link-target');
    symlinkSync(target, path.join(root, 'link'), 'dir');
    const reportDir = path.join(root, 'link', 'mutation');
    await expect(runMutation({ root, config: config(), reportDir, mutatorBin: bin })).rejects.toMatchObject({
      code: 'REPORT_DIR_OUTSIDE_ROOT',
    });
    expect(existsSync(path.join(target, 'mutation'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('accepts a reportDir inside the root', async () => {
    const { root, bin, marker } = stubCli("console.log('{}');");
    const reportDir = path.join(root, '.veritas', 'runs', 'r1', 'mutation');
    const r = await runMutation({ root, config: config(), reportDir, mutatorBin: bin });
    expect(r.status).toBe('error'); // the stub writes no report
    expect(existsSync(reportDir)).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('report-derived strings are redacted', () => {
  const secretSource = `export function f(a: number): number {\n  const password=supersecret;\n  return a;\n}\n${PRIVATE_KEY}\n`;
  const report = {
    schemaVersion: '2',
    files: {
      'src/f.ts': {
        source: secretSource,
        mutants: [
          {
            id: 'k1',
            mutatorName: 'StringLiteral token=abcdef123456',
            replacement: 'const password=othersecret',
            location: { start: { line: 2, column: 3 }, end: { line: 2, column: 30 } },
            status: 'Ignored',
            statusReason: 'accepted: api_key=zzzzzzzzzz',
            killedBy: [],
            coveredBy: ['t1'],
          },
          {
            id: 'k2',
            mutatorName: 'StringLiteral',
            replacement: '""',
            location: { start: { line: 5, column: 1 }, end: { line: 7, column: 30 } },
            status: 'Survived',
            coveredBy: ['t1'],
          },
        ],
      },
    },
    testFiles: { 'test/f.test.ts': { tests: [{ id: 't1', name: 'uses secret=hunter2hunter2' }] } },
  };

  it('redacts original, replacement, operator, statusReason and test refs of imported mutants', () => {
    const root = tempDir('review-redact');
    for (const source of ['mutator', 'stryker'] as const) {
      const mutants = importMutationReport(report, { root, source });
      const text = JSON.stringify(mutants);
      for (const secret of [
        'supersecret',
        'othersecret',
        'abcdef123456',
        'zzzzzzzzzz',
        'hunter2hunter2',
        'MIIEow',
      ])
        expect(text).not.toContain(secret);
      expect(mutants[0]?.original).toContain('[REDACTED]');
      expect(mutants[0]?.replacement).toContain('[REDACTED]');
      expect(mutants[0]?.statusReason).toContain('[REDACTED]');
      expect(mutants[1]?.original).toContain('[REDACTED]');
    }
  });

  it('redacts mutants, the agent report and stderr returned by runMutation', async () => {
    const { root, bin } = stubCli(
      [
        `fs.writeFileSync(dir + '/mutation.json', ${JSON.stringify(JSON.stringify(report))});`,
        `console.log(JSON.stringify({ gaps: [{ key: 'k2', source: 'password=supersecret' }] }));`,
      ].join('\n'),
    );
    const r = await runMutation({
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
    });
    expect(r.status).toBe('succeeded');
    const text = JSON.stringify(r);
    for (const secret of ['supersecret', 'othersecret', 'hunter2hunter2', 'MIIEow'])
      expect(text).not.toContain(secret);
  });

  it('redacts the stderr summary of a failing baseline', async () => {
    const { root, bin } = stubCli("console.error('db password=supersecret refused'); process.exit(4);");
    mkdirSync(path.join(root, 'out'));
    const r = await runMutation({
      root,
      config: config(),
      reportDir: path.join(root, 'out'),
      mutatorBin: bin,
    });
    expect(r.status).toBe('failed');
    expect(r.detail).not.toContain('supersecret');
  });
});

describe('test refs are always posix', () => {
  it('normalizes a backslash test file in a mutator test name', () => {
    expect(mutatorTestRef('test\\f.test.ts#suite > case')).toEqual({
      file: 'test/f.test.ts',
      suitePath: ['suite'],
      name: 'case',
    });
  });
});

describe('reproduction quoting is the same on every OS', () => {
  it('quotes arguments containing backslashes, spaces or quotes and leaves plain posix paths bare', () => {
    expect(shellQuote('/tmp/project')).toBe('/tmp/project');
    expect(shellQuote('C:\\Users\\RUNNER~1\\proj')).toBe("'C:\\Users\\RUNNER~1\\proj'");
    expect(shellQuote('/tmp/my project')).toBe("'/tmp/my project'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
