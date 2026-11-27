import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { longPath, parseJestReport, relativeKey, runJest } from '../src/run.js';
import { copyJestFixture, FIXTURE } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A report Jest 30.5 wrote with --json for the jest-app fixture plus a failing and a broken test file. */
function recordedReport(root: string): unknown {
  const text = readFileSync(path.join(here, 'data', 'jest-30-report.json'), 'utf8');

  return JSON.parse(text.replaceAll('<ROOT>', root.split(path.sep).join('/')));
}

describe('parseJestReport', () => {
  it('keeps a failure of one of two tests sharing a full name, in either order', () => {
    const root = realpathSync(tmpdir());
    const file = path.join(root, 'twice.test.js');
    const report = (statuses: string[]) => ({
      success: !statuses.includes('failed'),
      testResults: [
        {
          name: file,
          status: statuses.includes('failed') ? 'failed' : 'passed',
          assertionResults: statuses.map((status) => ({ fullName: 'works', status })),
        },
      ],
    });

    for (const statuses of [
      ['failed', 'passed'],
      ['passed', 'failed'],
    ])
      expect(Object.fromEntries(parseJestReport(root, report(statuses)).tests)).toEqual({
        'twice.test.js::works': 'failed',
      });
    // Two passes stay a pass.
    expect(Object.fromEntries(parseJestReport(root, report(['passed', 'passed'])).tests)).toEqual({
      'twice.test.js::works': 'passed',
    });
  });

  it('names tests <file>::<fullName> and maps Jest statuses', () => {
    const root = realpathSync(tmpdir());
    const run = parseJestReport(root, recordedReport(root));

    expect(
      run.tests.get(
        'test/shipping-boundary.test.ts::shippingFee at the free shipping threshold ships free exactly at the threshold',
      ),
    ).toBe('passed');
    expect(run.tests.get('test/shipping-boundary.test.ts::shippingFee shippingFee(10) is 500')).toBe(
      'passed',
    );
    // `xit` is pending and `test.todo` is todo in Jest's report; neither ran.
    expect(run.tests.get('test/shipping-boundary.test.ts::shippingFee is skipped')).toBe('skipped');
    expect(run.tests.get('test/failing.test.ts::later')).toBe('skipped');
    expect(run.tests.get('test/failing.test.ts::fails')).toBe('failed');
    expect(run.tests.get('test/tautological.test.ts::pricing works')).toBe('passed');
    // A file that fails to load has no test results.
    expect(run.tests.get('test/broken.test.ts::(file)')).toBe('failed');
    expect(run.passed).toBe(9);
    expect(run.failed).toBe(2);
    expect(run.failures).toHaveLength(2);
    expect(run.failures.find((f) => f.startsWith('test/failing.test.ts::fails'))).toContain('Expected: 3');
    expect(run.failures.find((f) => f.startsWith('test/broken.test.ts'))).toContain(
      'Could not locate module',
    );
  });

  it('builds the full name from the titles when the report has none', () => {
    const root = realpathSync(tmpdir());
    const run = parseJestReport(root, {
      testResults: [
        {
          name: path.join(root, 'a.test.ts'),
          status: 'passed',
          assertionResults: [{ ancestorTitles: ['outer', 'inner'], title: 'case', status: 'passed' }],
        },
      ],
    });

    expect([...run.tests.keys()]).toEqual(['a.test.ts::outer inner case']);
  });

  it('fails a file whose hook threw although all its tests passed, and a run Jest says did not succeed', () => {
    const root = realpathSync(tmpdir());
    const run = parseJestReport(root, {
      success: false,
      testResults: [
        {
          name: path.join(root, 'hooks.test.ts'),
          status: 'failed',
          message: '● Test suite failed to run\n\n    afterAll threw: boom',
          assertionResults: [{ fullName: 'passes', title: 'passes', status: 'passed' }],
        },
      ],
    });

    expect(run.tests.get('hooks.test.ts::passes')).toBe('passed');
    expect(run.tests.get('hooks.test.ts::(file)')).toBe('failed');
    expect(run.failed).toBe(1);
    expect(run.failures[0]).toContain('afterAll threw: boom');
    const unexplained = parseJestReport(root, { success: false, testResults: [] });

    expect(unexplained.tests.get('(run)::(report)')).toBe('failed');
    expect(unexplained.failed).toBe(1);
  });

  it('keys files by POSIX paths relative to the real long form of the directory', () => {
    // A link stands in for a Windows 8.3 short name: Jest reports the real path of a directory given another way.
    const real = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'veritas-jest-long-')));
    const link = path.join(realpathSync.native(tmpdir()), `veritas-jest-short-${process.pid}-${Date.now()}`);
    symlinkSync(real, link, 'junction');

    expect(longPath(path.join(link, 'test', 'missing.test.ts'))).toBe(
      path.join(real, 'test', 'missing.test.ts'),
    );
    expect(relativeKey(link, path.join(real, 'test', 'a.test.ts'))).toBe('test/a.test.ts');
    const run = parseJestReport(link, {
      testResults: [
        {
          name: path.join(real, 'test', 'a.test.ts'),
          status: 'passed',
          assertionResults: [{ fullName: 'a', status: 'passed' }],
        },
      ],
    });

    expect([...run.tests.keys()]).toEqual(['test/a.test.ts::a']);
  });

  it('reads nothing from a report without test results', () => {
    expect(parseJestReport(tmpdir(), null)).toMatchObject({ tests: new Map(), passed: 0, failed: 0 });
  });
});

describe('runJest', () => {
  it('fails a run that exits nonzero although its report names no failure', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-jest-exit-')));
    mkdirSync(path.join(root, 'node_modules', 'jest', 'bin'), { recursive: true });
    // A stand-in Jest that writes an all-passing report and then exits with 1.
    writeFileSync(
      path.join(root, 'node_modules', 'jest', 'bin', 'jest.js'),
      [
        "const fs = require('node:fs');",
        "const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);",
        `fs.writeFileSync(out, JSON.stringify({ success: true, testResults: [{ name: ${JSON.stringify(path.join(root, 'a.test.js'))}, status: 'passed', assertionResults: [{ fullName: 'a', status: 'passed' }] }] }));`,
        "process.stderr.write('Jest did not exit one second after the test run has completed.');",
        'process.exit(1);',
      ].join('\n'),
    );
    writeFileSync(path.join(root, 'node_modules', 'jest', 'package.json'), '{"type":"commonjs"}');
    const run = await runJest(root, { timeoutMs: 60_000, label: 'exit' });

    expect(run.status).toBe('ok');

    if (run.status !== 'ok') return;
    expect(run.tests.get('a.test.js::a')).toBe('passed');
    expect(run.tests.get('(run)::(exit)')).toBe('failed');
    expect(run.failed).toBe(1);
    expect(run.failures[0]).toContain('did not exit');
  });
});

describe.skipIf(!existsSync(path.join(FIXTURE, 'node_modules', 'jest')))(
  'runJest on the jest-app fixture',
  () => {
    it('runs the project Jest and reads its report, for some files or all', async () => {
      const root = copyJestFixture('jest-run');
      const all = await runJest(root, { timeoutMs: 120_000, label: 'all' });

      // The detail says why, should the run fail on some platform.
      expect(all, JSON.stringify(all.status === 'ok' ? all.failures : all)).toMatchObject({ status: 'ok' });

      if (all.status !== 'ok') return;
      expect(all.failed).toBe(0);
      expect(all.passed).toBe(9);
      expect(all.tests.get('test/shipping-boundary.test.ts::shippingFee is skipped')).toBe('skipped');
      const one = await runJest(root, {
        timeoutMs: 120_000,
        label: 'one',
        files: ['test/discount-weak.test.ts'],
      });

      expect(one, JSON.stringify(one.status === 'ok' ? one.failures : one)).toMatchObject({ status: 'ok' });
      expect(one.status === 'ok' && [...one.tests.keys()]).toEqual([
        'test/discount-weak.test.ts::discountAmount gives a discount on large orders',
        'test/discount-weak.test.ts::discountAmount gives no discount on small orders',
      ]);
    }, 180_000);
  },
);
