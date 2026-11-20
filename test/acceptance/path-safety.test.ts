import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

function outsideDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-outside-')));
  writeFileSync(
    path.join(dir, 'secret.ts'),
    'export function leaked(x: number): number { return x > 1 ? 1 : 0; }\n',
  );
  writeFileSync(path.join(dir, 'NOTES.md'), 'Values of 5 or more are leaked.\n');

  return dir;
}

describe('project root containment', () => {
  it('does not read sources or docs through symlinks that leave the project', () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    const outside = outsideDir();
    symlinkSync(path.join(outside, 'secret.ts'), path.join(dir, 'src/linked.ts'));
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    symlinkSync(outside, path.join(dir, 'docs/external'), 'junction');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const run = json<{ runId: string }>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const read = (f: string) => readFileSync(path.join(dir, '.veritas/runs', run.runId, f), 'utf8');
    expect(read('code-index.json')).not.toContain('leaked');
    expect(read('evidence.json')).not.toContain('are leaked');
    expect(readdirSync(outside).sort()).toEqual(['NOTES.md', 'secret.ts']);
  });

  it('rejects analysis paths and run ids that escape the root', () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const analyze = runCli(['analyze', '../../etc', '--json'], dir);
    expect(analyze.status).not.toBe(0);
    const replay = runCli(['replay', '../../outside', '--json'], dir);
    expect(replay.status).toBe(2);
    const explain = runCli(['explain', '../../x', '--json'], dir);
    expect(explain.status).not.toBe(0);
  });

  it('refuses configuration that points analysis outside the project', () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    const outside = outsideDir();
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const file = path.join(dir, '.veritas/config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.analysis.include = [`${path.relative(dir, outside).split(path.sep).join('/')}/**/*.ts`];
    writeFileSync(file, JSON.stringify(config));
    const run = runCli(['run', '--profile', 'quick', '--json'], dir);
    const runs = existsSync(path.join(dir, '.veritas/runs'))
      ? readdirSync(path.join(dir, '.veritas/runs'))
      : [];

    for (const r of runs) {
      const index = path.join(dir, '.veritas/runs', r, 'code-index.json');

      if (existsSync(index)) expect(readFileSync(index, 'utf8')).not.toContain('leaked');
    }
    expect([0, 2, 3]).toContain(run.status);
    expect(readdirSync(outside).sort()).toEqual(['NOTES.md', 'secret.ts']);
  });

  it('does not print a tampered artifact path from a run as a location', () => {
    const dir = copyFixture('discount-boundary', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const prove = json<{ runId: string; findings: { id: string; claimIds: string[] }[] }>(
      runCli(['prove', '--include-proposed', '--json'], dir),
    );
    // A finding backed by a formal claim, so explain has a solver input to show.
    const finding = prove.findings.find((f) => f.claimIds.length > 0);
    expect(finding).toBeDefined();
    const file = path.join(dir, '.veritas/runs', prove.runId, 'claims.json');
    const claims = JSON.parse(readFileSync(file, 'utf8'));
    for (const claim of claims.data) claim.solverInputArtifact = '../../../outside.smt2';
    writeFileSync(file, JSON.stringify(claims));
    const explain = runCli(['explain', finding?.id as string], dir);
    expect(explain.status, explain.stderr).toBe(0);
    expect(explain.stdout).not.toContain('outside.smt2');
    expect(explain.stdout).toContain('unsafe location omitted');
  });
});
