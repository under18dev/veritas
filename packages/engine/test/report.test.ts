import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReportInput, initProject, runVeritas } from '../src/index.js';

function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-engine-report-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'p', type: 'module', devDependencies: { vitest: '5.1.1' } }),
  );
  writeFileSync(path.join(root, 'README.md'), '# p\n\nPasswords need 8 characters minimum to be accepted.\n');
  writeFileSync(
    path.join(root, 'src/password.ts'),
    'export function isLongEnough(length: number): boolean {\n  return length >= 8;\n}\n',
  );
  initProject(root);

  return root;
}

// Each test runs a whole quick-profile run (about 2.5 s alone), which can pass 5 s on a loaded machine.
describe('report input', { timeout: 30_000 }, () => {
  it('carries the metadata of the run and writes it into the JSON report', async () => {
    const root = project();
    const { runId, dir } = await runVeritas({
      root,
      command: 'run',
      stages: ['index', 'discover', 'spec', 'map', 'assess', 'report'],
      offline: true,
    });
    const input = buildReportInput(root, runId);
    expect(input.meta.runId).toBe(runId);
    expect(input.meta.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as { meta: unknown };
    expect(report.meta).toEqual(input.meta);
  });

  it('refuses to report a run whose artifact is corrupt instead of leaving the section empty', async () => {
    const root = project();
    const { runId, dir } = await runVeritas({
      root,
      command: 'run',
      stages: ['index', 'discover', 'spec', 'map', 'assess'],
      offline: true,
    });
    writeFileSync(path.join(dir, 'findings.json'), '{"meta":{},"data":[]}');
    expect(() => buildReportInput(root, runId)).toThrow(/findings\.json/);
  });
});
