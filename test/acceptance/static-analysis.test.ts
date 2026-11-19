import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

interface TestMap {
  tests: { id: string; file: string; name: string; calledSymbols: string[] }[];
}

/** Test-map artifacts of every run, newest last. */
function testMaps(dir: string): TestMap[] {
  const runs = path.join(dir, '.veritas/runs');
  return readdirSync(runs)
    .sort()
    .map((run) => path.join(runs, run, 'test-map.json'))
    .filter(existsSync)
    .map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { data: TestMap }).data);
}

describe('test files are parsed, never executed, by the static stages', () => {
  it('indexes a test whose top level would write a marker file and throw, without running it', () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    // Markers inside and outside the project: either would only appear if the test file were imported.
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-marker-')));
    const markers = [path.join(dir, 'EXECUTED.txt'), path.join(outside, 'EXECUTED.txt')];
    writeFileSync(
      path.join(dir, 'test/side-effect.test.ts'),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { expect, it } from 'vitest';",
        "import { discountAmount } from '../src/pricing.js';",
        '',
        ...markers.map((marker) => `writeFileSync(${JSON.stringify(marker)}, 'executed');`),
        "throw new Error('this test file must never be executed by static analysis');",
        '',
        "it('discounts an order of exactly 1000', () => {",
        '  expect(discountAmount(1000)).toBe(100);',
        '});',
        '',
      ].join('\n'),
    );
    expect(runCli(['init', '--yes'], dir).status).toBe(0);

    const discover = runCli(['discover', '--json'], dir);
    expect(discover.status, discover.stderr).toBe(0);
    const analyze = runCli(['analyze', '--json'], dir);
    expect(analyze.status, analyze.stderr).toBe(0);
    const stages = json<{ stages: { stage: string; status: string }[] }>(analyze).stages;
    expect(stages.map((s) => [s.stage, s.status])).toEqual(
      ['index', 'discover', 'spec', 'map', 'assess'].map((stage) => [stage, 'succeeded']),
    );
    const list = runCli(['spec', 'list', '--json'], dir);
    expect(list.status, list.stderr).toBe(0);
    const quick = runCli(['run', '--profile', 'quick', '--json'], dir);
    expect(quick.status, quick.stderr).toBe(0);

    for (const marker of markers) expect(existsSync(marker), marker).toBe(false);
    const maps = testMaps(dir);
    expect(maps).toHaveLength(2);
    for (const map of maps) {
      const test = map.tests.find((t) => t.file === 'test/side-effect.test.ts');
      expect(test?.name).toBe('discounts an order of exactly 1000');
      expect(test?.calledSymbols.some((symbol) => symbol.endsWith('discountAmount'))).toBe(true);
    }
  });
});
