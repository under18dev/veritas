import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVitestReport } from '../src/run.js';

describe('parseVitestReport', () => {
  const root = realpathSync(tmpdir());
  const file = path.join(root, 'twice.test.ts');
  const report = (statuses: string[]) => ({
    testResults: [
      {
        name: file,
        status: 'failed',
        assertionResults: statuses.map((status) => ({ fullName: 'suite > works', status })),
      },
    ],
  });

  it('keeps a failure of one of two tests sharing a full name, in either order', () => {
    for (const statuses of [
      ['failed', 'passed'],
      ['passed', 'failed'],
    ]) {
      const run = parseVitestReport(root, report(statuses));
      expect(Object.fromEntries(run.tests)).toEqual({ 'twice.test.ts::suite > works': 'failed' });
      expect(run.failed).toBe(1);
    }
  });

  it('reads tests with names of their own as they are, and a file that did not load as <file>::(file)', () => {
    const run = parseVitestReport(root, {
      testResults: [
        {
          name: file,
          status: 'passed',
          assertionResults: [
            { fullName: 'a', status: 'passed' },
            { fullName: 'b', status: 'skipped' },
          ],
        },
        { name: path.join(root, 'broken.test.ts'), status: 'failed', message: 'boom' },
      ],
    });

    expect(Object.fromEntries(run.tests)).toEqual({
      'twice.test.ts::a': 'passed',
      'twice.test.ts::b': 'skipped',
      'broken.test.ts::(file)': 'failed',
    });
    expect(run.failures).toEqual(['broken.test.ts: boom']);
  });
});
