import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { json, runCli } from './helpers.js';
import { type RunJson, setup } from './pipeline-shared.js';

describe('discount-boundary end to end: replay', () => {
  it('replays a run with the same stages and records a new run', () => {
    const dir = setup('discount-boundary');
    const first = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const replay = json<RunJson>(runCli(['replay', first.runId, '--json'], dir));
    expect(replay.runId).not.toBe(first.runId);
    expect(replay.stages.map((s) => s.stage)).toEqual(first.stages.map((s) => s.stage));
    expect(replay.findings.map((f) => f.id).sort()).toEqual(first.findings.map((f) => f.id).sort());
  });

  it('replays a prove run with the same properties, engine and scope', () => {
    const dir = setup('discount-boundary');
    expect(runCli(['run', '--profile', 'quick', '--json'], dir).status).toBe(0);
    const list = json<{ properties: { id: string }[] }>(runCli(['spec', 'list', '--json'], dir));
    const property = list.properties[0]?.id as string;
    const first = json<RunJson>(
      runCli(['prove', '--property', property, '--include-proposed', '--engine', 'z3', '--json'], dir),
    );
    const replay = json<RunJson>(runCli(['replay', first.runId, '--json'], dir));
    const recorded = (runId: string) =>
      JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, 'run.json'), 'utf8')).data as {
        options: unknown;
        scope: { paths: string[] };
      };
    expect(recorded(first.runId).options).toEqual({
      includeProposed: true,
      propertyIds: [property],
      formalEngine: 'z3',
      offline: true,
    });
    expect(recorded(replay.runId).options).toEqual(recorded(first.runId).options);
    expect(recorded(replay.runId).scope.paths).toEqual(recorded(first.runId).scope.paths);
  });

  it('replays the run with the command shown in the rendered markdown report', () => {
    const dir = setup('discount-boundary');
    const first = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const rendered = runCli(['report', '--format', 'markdown'], dir);
    expect(rendered.status, rendered.stderr).toBe(0);
    const command = /`(veritas replay [^`]+)`/.exec(rendered.stdout)?.[1];
    expect(command).toBe(`veritas replay ${first.runId}`);
    // The report written by the run shows the same command.
    expect(readFileSync(path.join(dir, '.veritas/runs', first.runId, 'report.md'), 'utf8')).toContain(
      `\`${command}\``,
    );
    const [program, ...args] = (command as string).split(' ');
    expect(program).toBe('veritas');
    const replay = json<RunJson>(runCli([...args, '--json'], dir));
    expect(replay.runId).not.toBe(first.runId);
    expect(replay.stages.map((s) => s.stage)).toEqual(first.stages.map((s) => s.stage));
    expect(replay.findings.map((f) => f.id).sort()).toEqual(first.findings.map((f) => f.id).sort());
    expect(first.findings.length).toBeGreaterThan(0);
  });
});

describe('changes since a git ref', () => {
  it('runs mutation only with the tests that reach a file changed since the ref', () => {
    const dir = setup('discount-boundary');
    const git = (...args: string[]) =>
      spawnSync(
        'git',
        ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
        {
          cwd: dir,
          stdio: 'ignore',
        },
      );
    writeFileSync(
      path.join(dir, 'src/other.ts'),
      'export function twice(n: number): number {\n  return n * 2;\n}\n',
    );
    writeFileSync(
      path.join(dir, 'test/other.test.ts'),
      "import { expect, it } from 'vitest';\nimport { twice } from '../src/other';\nit('doubles', () => { expect(twice(2)).toBe(4); });\n",
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'other');
    writeFileSync(
      path.join(dir, 'src/other.ts'),
      'export function twice(n: number): number {\n  return n + n;\n}\n',
    );
    // A new file git does not track yet, and its test.
    writeFileSync(
      path.join(dir, 'src/fresh.ts'),
      'export function half(n: number): number {\n  return n / 2;\n}\n',
    );
    writeFileSync(
      path.join(dir, 'test/fresh.test.ts'),
      "import { expect, it } from 'vitest';\nimport { half } from '../src/fresh';\nit('halves', () => { expect(half(4)).toBe(2); });\n",
    );
    const result = runCli(['mutate', '--since', 'HEAD', '--json'], dir);
    expect([0, 1, 4], result.stderr).toContain(result.status);
    const runId = json<RunJson>(result).runId;
    const config = readFileSync(
      path.join(dir, '.veritas/runs', runId, 'mutation/vitest.mutation.config.mjs'),
      'utf8',
    );
    const { files } = JSON.parse(/const options = (\{[\s\S]*?\n\});/.exec(config)?.[1] ?? '{}') as {
      files: string[];
    };
    const names = files.map((f) => path.basename(f));
    expect(names).toContain('other.test.ts');
    expect(names).toContain('fresh.test.ts');
    // The tests of the unchanged src/pricing.ts are left out. (A test that imports no project file is kept, since
    // what it runs is not known.)
    expect(names).not.toContain('discount-weak.test.ts');
    expect(names).not.toContain('shipping-boundary.test.ts');
    // Mutants of the unchanged file were outside --since: pending, not "no coverage".
    const mutation = JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, 'mutation.json'), 'utf8'))
      .data as {
      mutants: { status: string; location: { file: string } }[];
    };
    const unchanged = mutation.mutants.filter((m) => m.location.file === 'src/pricing.ts');
    expect(unchanged.every((m) => m.status !== 'no_coverage')).toBe(true);
  });

  it('marks properties of changed code with the change and refuses refs that look like options', () => {
    const dir = setup('discount-boundary');
    const file = path.join(dir, 'src/pricing.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('total > 1000', 'total > 999'));
    const result = runCli(['analyze', '--since', 'HEAD', '--json'], dir);
    expect([0, 4], result.stderr).toContain(result.status);
    const runId = json<RunJson>(result).runId;
    const properties = JSON.parse(
      readFileSync(path.join(dir, '.veritas/runs', runId, 'properties.json'), 'utf8'),
    ).data.properties as { formalExpression?: string; assumptions: string[]; targetSymbols: string[] }[];
    const moved = properties.find((p) => p.formalExpression === 'total > 999');
    expect(moved?.assumptions).toContain(
      'this comparison changed since HEAD; check whether the boundary moved on purpose',
    );
    const untouched = properties.filter((p) => p.targetSymbols.includes('src/pricing.ts#shippingFee'));

    for (const p of untouched) expect(p.assumptions.join(' ')).not.toMatch(/changed since/);
    const refused = runCli(['analyze', '--since', '--output=x', '--json'], dir);
    expect(refused.status).toBe(2);
    expect(json(refused)).toMatchObject({ code: 'SINCE_INVALID' });
  });
});

describe('existing mutation reports', () => {
  const strykerReport = {
    schemaVersion: '2.0',
    thresholds: { high: 80, low: 60 },
    framework: { name: 'StrykerJS', version: '9.0.0' },
    files: {
      'src/pricing.ts': {
        language: 'typescript',
        source: '',
        mutants: [
          {
            id: '7',
            mutatorName: 'EqualityOperator',
            replacement: 'total >= 1000',
            location: { start: { line: 3, column: 7 }, end: { line: 3, column: 19 } },
            status: 'Survived',
            coveredBy: [],
          },
        ],
      },
    },
  };

  it('imports a mutation-testing-elements report instead of running mutator and relates it to properties', () => {
    const dir = setup('discount-boundary');
    writeFileSync(path.join(dir, 'reports-mutation.json'), JSON.stringify(strykerReport));
    const result = runCli(['mutate', '--import', 'reports-mutation.json', '--json'], dir);
    expect([0, 4], result.stderr).toContain(result.status);
    const summary = json<RunJson>(result);
    const mutate = summary.stages.find((s) => s.stage === 'mutate');
    expect(mutate?.status).toBe('succeeded');
    expect(mutate?.messages.join('\n')).toMatch(
      /imported 1 mutant\(s\) from reports-mutation\.json \(StrykerJS\)/,
    );
    const mutation = JSON.parse(
      readFileSync(path.join(dir, '.veritas/runs', summary.runId, 'mutation.json'), 'utf8'),
    ).data as {
      backend: { name: string; version: string };
      mutants: { status: string; relevance: string }[];
    };
    expect(mutation.backend).toEqual({ name: 'imported', version: '9.0.0' });
    expect(mutation.mutants.map((m) => [m.status, m.relevance])).toEqual([['survived', 'spec_relevant']]);
  });

  it('keeps every --scope given to mutate, not only the last one', () => {
    const dir = setup('discount-boundary');
    writeFileSync(path.join(dir, 'reports-mutation.json'), JSON.stringify(strykerReport));
    const args = ['--import', 'reports-mutation.json', '--scope', 'src/pricing.ts', '--scope', 'test'];
    const result = runCli(['mutate', ...args, '--json'], dir);
    expect([0, 4], result.stderr).toContain(result.status);
    const { runId } = json<RunJson>(result);
    const run = JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, 'run.json'), 'utf8')).data as {
      scope: { paths: string[] };
    };
    expect(run.scope.paths).toEqual(['src/pricing.ts', 'test']);
  });

  it('never treats an empty report, or pending mutants with --since, as complete mutation evidence', () => {
    const dir = setup('discount-boundary');
    writeFileSync(path.join(dir, 'empty.json'), JSON.stringify({ schemaVersion: '2.0', files: {} }));
    const empty = json<RunJson>(runCli(['mutate', '--import', 'empty.json', '--json'], dir));
    const emptyStage = empty.stages.find((s) => s.stage === 'mutate');
    expect(emptyStage?.status).toBe('partial');
    expect(emptyStage?.messages.join('\n')).toMatch(/contains no mutant/);
    expect(empty.status).not.toBe('pass');
    const pending = structuredClone(strykerReport);
    const first = pending.files['src/pricing.ts'].mutants[0] as { status: string };
    first.status = 'Pending';
    writeFileSync(path.join(dir, 'pending.json'), JSON.stringify(pending));
    const since = json<RunJson>(
      runCli(['mutate', '--import', 'pending.json', '--since', 'HEAD', '--json'], dir),
    );
    expect(since.stages.find((s) => s.stage === 'mutate')?.status).toBe('partial');
  });

  it('refuses reports outside the project, invalid reports and --import with --kill-matrix', () => {
    const dir = setup('discount-boundary');
    writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ schemaVersion: '1', files: {} }));
    writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(strykerReport));
    const cases: [string[], string][] = [
      [['--import', '../outside.json'], 'PATH_OUTSIDE_ROOT'],
      [['--import', 'bad.json'], 'MUTATION_REPORT_INVALID'],
      [['--import', 'missing.json'], 'MUTATION_REPORT_UNREADABLE'],
      [['--import', 'ok.json', '--kill-matrix'], 'OPTION_CONFLICT'],
    ];

    for (const [args, code] of cases) {
      const result = runCli(['mutate', ...args, '--json'], dir);
      expect(result.status, args.join(' ')).toBe(2);
      expect(json(result), args.join(' ')).toMatchObject({ status: 'error', code });
    }
  });
});
