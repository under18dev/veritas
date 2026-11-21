import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJestReport, runJest } from '../src/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../../../fixtures/jest-app');

/** A report Jest 30.5 wrote with --json for the jest-app fixture plus a failing and a broken test file. */
function recordedReport(root: string): unknown {
  const text = readFileSync(path.join(here, 'data', 'jest-30-report.json'), 'utf8');

  return JSON.parse(text.replaceAll('<ROOT>', root.split(path.sep).join('/')));
}

describe('parseJestReport', () => {
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

  it('reads nothing from a report without test results', () => {
    expect(parseJestReport(tmpdir(), null)).toMatchObject({ tests: new Map(), passed: 0, failed: 0 });
  });
});

describe.skipIf(!existsSync(path.join(FIXTURE, 'node_modules', 'jest')))(
  'runJest on the jest-app fixture',
  () => {
    it('runs the project Jest and reads its report, for some files or all', async () => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-jest-run-')));
      cpSync(FIXTURE, root, { recursive: true, filter: (src) => !src.includes('node_modules') });
      symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(root, 'node_modules'), 'junction');
      const all = await runJest(root, { timeoutMs: 120_000, label: 'all' });

      expect(all.status).toBe('ok');

      if (all.status !== 'ok') return;
      expect(all.failed).toBe(0);
      expect(all.passed).toBe(9);
      expect(all.tests.get('test/shipping-boundary.test.ts::shippingFee is skipped')).toBe('skipped');
      const one = await runJest(root, {
        timeoutMs: 120_000,
        label: 'one',
        files: ['test/discount-weak.test.ts'],
      });

      expect(one.status === 'ok' && [...one.tests.keys()]).toEqual([
        'test/discount-weak.test.ts::discountAmount gives a discount on large orders',
        'test/discount-weak.test.ts::discountAmount gives no discount on small orders',
      ]);
    }, 180_000);
  },
);
