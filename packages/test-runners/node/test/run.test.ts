import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNodeTestReport, runNodeTest } from '../src/run.js';

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-node-run-')));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }));

  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }

  return root;
}

const PRICING = `export function discount(total: number): number {
  return total > 1000 ? 100 : 0;
}
`;

const SUITE = `import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { discount } from '../src/pricing.ts';

describe('discount', () => {
  it('gives 100 on large orders', () => {
    assert.equal(discount(2000), 100);
  });

  it('is wrong on purpose', () => {
    assert.equal(discount(10), 5);
  });

  it.skip('is skipped', () => {});

  it('is todo', { todo: 'later' }, () => {});

  describe('nested', () => {
    test('gives nothing on small orders', () => {
      assert.equal(discount(10), 0);
    });
  });
});

test('with subtests', async (t) => {
  await t.test('first', () => {
    t.assert.equal(discount(0), 0);
  });
  await t.test('second', () => {
    assert.equal(discount(5000), 100);
  });
});
`;

describe('runNodeTest', () => {
  it('runs the real node --test and keys every test, subtests included, by file and full name', async () => {
    const root = project({ 'src/pricing.ts': PRICING, 'test/pricing.test.ts': SUITE });
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'all' });

    expect(run.status).toBe('ok');

    if (run.status !== 'ok') return;
    expect(Object.fromEntries(run.tests)).toEqual({
      'test/pricing.test.ts::discount > gives 100 on large orders': 'passed',
      'test/pricing.test.ts::discount > is wrong on purpose': 'failed',
      'test/pricing.test.ts::discount > is skipped': 'skipped',
      'test/pricing.test.ts::discount > is todo': 'skipped',
      'test/pricing.test.ts::discount > nested > gives nothing on small orders': 'passed',
      'test/pricing.test.ts::with subtests > first': 'passed',
      'test/pricing.test.ts::with subtests > second': 'passed',
      'test/pricing.test.ts::with subtests': 'passed',
    });
    expect(run.passed).toBe(5);
    expect(run.failed).toBe(1);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]).toMatch(/^test\/pricing\.test\.ts::discount > is wrong on purpose: .*0 !== 5/);
  });

  it('keys subtests a helper in another file registers under the test that ran them', async () => {
    const root = project({
      'test/helper.mjs': "export async function check(t) {\n  await t.test('child', () => {});\n}\n",
      'test/a.test.mjs': `import { test } from 'node:test';
import { check } from './helper.mjs';
test('first parent', async (t) => { await check(t); });
test('second parent', async (t) => { await check(t); });
`,
      'test/b.test.mjs': `import { test } from 'node:test';
import { check } from './helper.mjs';
test('other file', async (t) => { await check(t); });
`,
    });
    const run = await runNodeTest(root, {
      timeoutMs: 60_000,
      label: 'helper',
      files: ['test/a.test.mjs', 'test/b.test.mjs'],
    });

    expect(run.status === 'ok' && Object.fromEntries(run.tests)).toEqual({
      'test/a.test.mjs::first parent > child': 'passed',
      'test/a.test.mjs::first parent': 'passed',
      'test/a.test.mjs::second parent > child': 'passed',
      'test/a.test.mjs::second parent': 'passed',
      'test/b.test.mjs::other file > child': 'passed',
      'test/b.test.mjs::other file': 'passed',
    });
  });

  it('runs only the files it is given', async () => {
    const root = project({
      'src/pricing.ts': PRICING,
      'test/pricing.test.ts': SUITE,
      'test/other.test.mjs': "import { test } from 'node:test';\ntest('other', () => {});\n",
    });
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'one', files: ['test/other.test.mjs'] });

    expect(run.status === 'ok' && Object.fromEntries(run.tests)).toEqual({
      'test/other.test.mjs::other': 'passed',
    });
  });

  it('records a file that does not load as <file>::(file), failed', async () => {
    const root = project({ 'test/broken.test.mjs': "import './missing.mjs';\n" });
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'broken' });

    expect(run.status === 'ok' && Object.fromEntries(run.tests)).toEqual({
      'test/broken.test.mjs::(file)': 'failed',
    });
    expect(run.status === 'ok' && run.failures[0]).toMatch(/^test\/broken\.test\.mjs:/);
    // What the file threw, not Node's generic "test failed" alone.
    expect(run.status === 'ok' && run.failures[0]).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });

  it("carries a file's own exception into its failure, and keeps a failing test's message as it is", async () => {
    const root = project({
      'test/throws.test.mjs': "import { test } from 'node:test';\nthrow new TypeError('boom at load');\n",
      'test/fails.test.mjs':
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.equal(1, 2, 'one is not two'));\n",
    });
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'throws' });

    expect(run.status === 'ok' && Object.fromEntries(run.tests)).toEqual({
      'test/fails.test.mjs::fails': 'failed',
      'test/throws.test.mjs::(file)': 'failed',
    });
    const failures = run.status === 'ok' ? run.failures : [];
    expect(failures.find((f) => f.startsWith('test/throws.test.mjs::(file)'))).toContain(
      'TypeError: boom at load',
    );
    const own = failures.find((f) => f.startsWith('test/fails.test.mjs::fails')) ?? '';
    expect(own).toContain('one is not two');
    expect(own).not.toContain('boom at load');
  });

  it('never reads a file that ended before any test reported as passing', async () => {
    const root = project({
      'src/exits.mjs': 'process.exit(0);\nexport const f = () => 1;\n',
      'test/import-exits.test.mjs': `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { f } from '../src/exits.mjs';
it('f is 2', () => assert.strictEqual(f(), 2));
`,
      'test/test-exits.test.mjs': `import { test } from 'node:test';
test('exits', () => { process.exit(0); });
test('never', () => {});
`,
      'test/fine.test.mjs': "import { test } from 'node:test';\ntest('fine', () => {});\n",
    });
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'exits' });

    expect(run.status === 'ok' && Object.fromEntries(run.tests)).toEqual({
      'test/import-exits.test.mjs::(file)': 'skipped',
      'test/test-exits.test.mjs::(file)': 'skipped',
      'test/fine.test.mjs::fine': 'passed',
    });
    expect(run.status === 'ok' && run.passed).toBe(1);
  });

  it('keeps real tests titled with their file path in a real run', async () => {
    const root = project({
      'test/titled.test.mjs': `import { test } from 'node:test';
test(import.meta.filename, () => {});
test('test/titled.test.mjs', () => {});
`,
    });
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'titled' });

    expect(run.status === 'ok' && Object.fromEntries(run.tests)).toEqual({
      [`test/titled.test.mjs::${path.join(root, 'test', 'titled.test.mjs')}`]: 'passed',
      'test/titled.test.mjs::test/titled.test.mjs': 'passed',
    });
    expect(run.status === 'ok' && run.passed).toBe(2);
  });

  it('records a failed hook of a suite under the suite', async () => {
    const root = project({
      'test/hook.test.mjs': `import { describe, before, it } from 'node:test';
describe('with a broken hook', () => {
  before(() => { throw new Error('no database'); });
  it('never runs', () => {});
});
`,
    });
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'hook' });

    expect(run.status).toBe('ok');
    expect(run.status === 'ok' && run.failed).toBeGreaterThan(0);
    expect(run.status === 'ok' && run.tests.get('test/hook.test.mjs::with a broken hook > never runs')).toBe(
      'failed',
    );
  });

  it('refuses file filters that read as options, globs or paths out of the project', async () => {
    const root = project({});

    for (const file of ['--test-only', '../x.test.mjs', '/abs.test.mjs', 'test/*.test.mjs', ''])
      expect(await runNodeTest(root, { timeoutMs: 5_000, label: 'x', files: [file] })).toMatchObject({
        status: 'error',
        detail: expect.stringMatching(/invalid test file/),
      });
  });

  it('refuses to write its report through a .veritas that links outside the project', async () => {
    const root = project({});
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-node-outside-')));
    symlinkSync(outside, path.join(root, '.veritas'), process.platform === 'win32' ? 'junction' : 'dir');
    const run = await runNodeTest(root, { timeoutMs: 30_000, label: 't' });

    expect(run).toMatchObject({ status: 'error' });
    expect(run.status === 'error' && run.detail).toMatch(/inside the project/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('does not read a stale report of an earlier run with the same label', async () => {
    const root = project({ 'test/a.test.mjs': "import { test } from 'node:test';\ntest('a', () => {});\n" });
    const stale = path.join(root, '.veritas', 'improve', 'node-test-same.json');
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(stale, JSON.stringify({ tests: [], success: true }));
    const run = await runNodeTest(root, { timeoutMs: 60_000, label: 'same' });

    expect(run.status === 'ok' && Object.fromEntries(run.tests)).toEqual({ 'test/a.test.mjs::a': 'passed' });
    expect(existsSync(stale)).toBe(true);
  });
});

describe('parseNodeTestReport', () => {
  const root = realpathSync(tmpdir());
  const file = path.join(root, 'test', 'a.test.mjs');
  const entry = {
    file,
    ancestors: [] as string[],
    type: 'test' as const,
    failureType: null,
    message: null,
  };

  it('never reads a run Node.js reported as failed as passing', () => {
    const run = parseNodeTestReport(root, {
      tests: [{ ...entry, name: 'a', status: 'passed' }],
      success: false,
    });

    expect(run.tests.get('(run)::(report)')).toBe('failed');
    expect(run.failed).toBe(1);
  });

  it('records a file reported as a whole without failing as skipped, never passed', () => {
    const run = parseNodeTestReport(root, {
      tests: [{ ...entry, name: 'test/a.test.mjs', status: 'passed' }],
      success: true,
    });

    expect(Object.fromEntries(run.tests)).toEqual({ 'test/a.test.mjs::(file)': 'skipped' });
    expect(run.passed).toBe(0);
  });

  it('keeps a real test titled with its file path, which Node.js does not report as the file itself', () => {
    const run = parseNodeTestReport(root, {
      tests: [
        { ...entry, name: file, status: 'passed', fileLevel: false },
        { ...entry, name: 'test/a.test.mjs', status: 'passed', fileLevel: false },
      ],
      success: true,
    });

    expect(Object.fromEntries(run.tests)).toEqual({
      [`test/a.test.mjs::${file}`]: 'passed',
      'test/a.test.mjs::test/a.test.mjs': 'passed',
    });
  });

  it('keeps a failure when a test of the same name passes later', () => {
    const run = parseNodeTestReport(root, {
      tests: [
        { ...entry, name: 'twice', status: 'failed', failureType: 'testCodeFailure', message: 'boom' },
        { ...entry, name: 'twice', status: 'passed' },
      ],
      success: false,
    });

    expect(run.tests.get('test/a.test.mjs::twice')).toBe('failed');
    expect(run.failures).toEqual(['test/a.test.mjs::twice: boom']);
  });

  it('leaves out suites, except one that failed by itself', () => {
    const run = parseNodeTestReport(root, {
      tests: [
        { ...entry, name: 'ok suite', type: 'suite', status: 'passed' },
        {
          ...entry,
          name: 'with failed tests',
          type: 'suite',
          status: 'failed',
          failureType: 'subtestsFailed',
        },
        { ...entry, name: 'threw', type: 'suite', status: 'failed', failureType: 'testCodeFailure' },
      ],
      success: false,
    });

    expect([...run.tests.keys()]).toEqual(['test/a.test.mjs::threw']);
  });

  it('reads nothing from a report that is not one', () => {
    expect(parseNodeTestReport(root, null)).toMatchObject({ passed: 0, failed: 0, failures: [] });
  });
});
