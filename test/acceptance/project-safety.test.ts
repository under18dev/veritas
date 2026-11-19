import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROFILE_STAGES, runVeritas } from '@under18dev/veritas-engine';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

interface RunJson {
  status: string;
  exitCode: number;
  runId: string;
  reasons: string[];
  stages: { stage: string; status: string; messages: string[] }[];
  findings: { id: string; kind: string; certainty: string }[];
}

function setup(name: string): string {
  const dir = copyFixture(name, { git: true, linkDeps: true });
  if (runCli(['init', '--yes'], dir).status !== 0) throw new Error('init failed');
  return dir;
}

/** Every project file (outside .git, node_modules and Veritas' own directory) with its bytes. */
function snapshot(dir: string, rel = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of readdirSync(path.join(dir, rel))) {
    const file = path.join(rel, entry);
    if (['.git', 'node_modules', '.veritas', '.mutator'].includes(file)) continue;
    if (statSync(path.join(dir, file)).isDirectory()) for (const [k, v] of snapshot(dir, file)) out.set(k, v);
    else out.set(file, readFileSync(path.join(dir, file)));
  }
  return out;
}

function gitStatus(dir: string): string[] {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: dir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

describe('mutation runs', () => {
  it('leave project sources and tests byte-identical and write only to tool directories', () => {
    const dir = setup('discount-boundary');
    const before = snapshot(dir);
    expect([...before.keys()]).toEqual(expect.arrayContaining(['src/pricing.ts', 'README.md']));

    const result = runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    const run = json<RunJson>(result);
    expect(run.stages.find((s) => s.stage === 'mutate')?.status).toBe('succeeded');
    const mutation = JSON.parse(
      readFileSync(path.join(dir, '.veritas/runs', run.runId, 'mutation.json'), 'utf8'),
    ).data as { mutants: { status: string }[] };
    expect(mutation.mutants.length).toBeGreaterThan(0);

    const after = snapshot(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, bytes] of before) expect(after.get(file)?.equals(bytes), file).toBe(true);

    // No tracked file is modified or deleted. New files are confined to Veritas' run directory, mutator's own
    // state directory and Vitest's cache inside node_modules (ignored in real projects).
    const status = gitStatus(dir);
    expect(status.filter((l) => !l.startsWith('?? '))).toEqual([]);
    const untracked = status.map((l) => l.slice(3));
    expect(
      untracked.filter(
        (f) =>
          !f.startsWith('.veritas/') && !f.startsWith('.mutator/') && !f.startsWith('node_modules/.vite/'),
      ),
    ).toEqual([]);
    expect(untracked.some((f) => f.startsWith('.mutator/'))).toBe(true);
  });
});

describe('tool errors', () => {
  it('exits 3 with tool_error when mutation cannot run because the test baseline fails', () => {
    const dir = setup('discount-boundary');
    writeFileSync(
      path.join(dir, 'test/broken.test.ts'),
      "import { expect, it } from 'vitest';\n\nit('is broken before any mutant', () => {\n  expect(1).toBe(2);\n});\n",
    );
    const result = runCli(['run', '--profile', 'standard', '--json'], dir);
    expect(result.status).toBe(3);
    const run = json<RunJson>(result);
    expect(run).toMatchObject({ status: 'tool_error', exitCode: 3 });
    const mutate = run.stages.find((s) => s.stage === 'mutate');
    expect(mutate?.status).toBe('failed');
    expect(mutate?.messages.join(' ')).toMatch(/tests fail without mutants/);
    expect(run.reasons.join(' ')).toMatch(/mutate=failed/);
    const recorded = JSON.parse(readFileSync(path.join(dir, '.veritas/runs', run.runId, 'run.json'), 'utf8'))
      .data as { verdict: string; exitCode: number; status: string };
    expect(recorded).toMatchObject({ verdict: 'tool_error', exitCode: 3, status: 'error' });

    // The text mode reports the same failure through the exit code.
    expect(runCli(['mutate'], dir).status).toBe(3);
  });
});

describe('Node API', () => {
  it('gives the same findings as the CLI for the same project and options', async () => {
    const cliDir = setup('discount-boundary');
    const apiDir = setup('discount-boundary');
    const cli = json<RunJson>(runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], cliDir));
    const api = await runVeritas({
      root: apiDir,
      command: 'run',
      stages: PROFILE_STAGES.deep,
      profile: 'deep',
      offline: false,
      includeProposed: true,
      llmProvider: null,
    });
    const pick = (findings: { id: string; kind: string; certainty: string }[]) =>
      findings
        .map((f) => ({ id: f.id, kind: f.kind, certainty: f.certainty }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(cli.findings.length).toBeGreaterThan(0);
    expect(pick(api.findings)).toEqual(pick(cli.findings));
    expect(api.decision.verdict).toBe(cli.status);
    expect(api.decision.exitCode).toBe(cli.exitCode);
    expect(api.run.stages.map((s) => [s.stage, s.status])).toEqual(
      cli.stages.map((s) => [s.stage, s.status]),
    );
    expect(api.dir).toBe(path.join(apiDir, '.veritas/runs', api.runId));
  }, 300_000);
});
