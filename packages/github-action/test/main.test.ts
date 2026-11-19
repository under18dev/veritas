import { execFileSync } from 'node:child_process';
import {
  cpSync,
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
import { initProject } from '@under18dev/veritas-core';
import { decideProperty, listProperties } from '@under18dev/veritas-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';

const root = path.resolve(import.meta.dirname, '../../..');
const fixture = path.join(root, 'fixtures', 'discount-boundary');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function linkPackages(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = path.join(source, name);
    const targetPath = path.join(target, name);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    symlinkSync(realpathSync(sourcePath), targetPath, 'junction');
  }
}

function copyFixture(): string {
  const target = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-action-main-')));
  cpSync(fixture, target, {
    recursive: true,
    filter: (source) => !source.includes('node_modules') && !source.includes('.mutator'),
  });
  linkPackages(path.join(fixture, 'node_modules'), path.join(target, 'node_modules'));
  git(target, 'init', '-q');
  git(target, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A');
  git(
    target,
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'user.name=fixture',
    'commit',
    '-qm',
    'fixture',
  );
  initProject(target);
  git(
    target,
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'user.name=fixture',
    'add',
    '.veritas/config.json',
  );
  git(
    target,
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'user.name=fixture',
    'commit',
    '-qm',
    'config',
  );
  return target;
}

function configure(
  rootDir: string,
  base: string,
  options: { profile?: string; inconclusive?: string } = {},
): { output: string; summary: string } {
  const eventPath = path.join(rootDir, 'event.json');
  const output = path.join(rootDir, `output-${Math.random().toString(36).slice(2)}.txt`);
  const summary = path.join(rootDir, `summary-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        base: { sha: base, repo: { full_name: 'org/project' } },
        head: { repo: { full_name: 'org/project' } },
      },
    }),
  );
  vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request');
  vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
  vi.stubEnv('GITHUB_REPOSITORY', 'org/project');
  vi.stubEnv('GITHUB_OUTPUT', output);
  vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
  vi.stubEnv('GITHUB_TOKEN', 'ghp_fakefakefakefakefakefakefakefakefake1234');
  vi.stubEnv('INPUT_WORKING_DIRECTORY', rootDir);
  vi.stubEnv('INPUT_PROFILE', options.profile ?? 'quick');
  vi.stubEnv('INPUT_INCONCLUSIVE', options.inconclusive ?? 'warn');
  vi.stubEnv('INPUT_SUMMARY', 'true');
  vi.stubEnv('INPUT_SINCE', '');
  return { output, summary };
}

function outputValues(file: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s, 2) as [string, string]),
  );
}

function allText(directory: string): string {
  if (!existsSync(directory)) return '';
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? allText(file) : readFileSync(file, 'utf8');
    })
    .join('\n');
}

afterEach(() => vi.unstubAllEnvs());

describe('main end to end', { timeout: 300_000 }, () => {
  it('runs quick verification and redacts the token from all outputs and artifacts', async () => {
    const project = copyFixture();
    const base = git(project, 'rev-parse', 'HEAD');
    const files = configure(project, base);
    expect(await main()).toBe(0);
    const values = outputValues(files.output);
    expect(values).toMatchObject({ verdict: 'pass_with_warnings', 'exit-code': '0' });
    expect(values['run-id']).toBeTruthy();
    expect(values['confirmed-findings']).toBe('0');
    expect(values['report-path']).toContain('.veritas/runs');
    const summary = readFileSync(files.summary, 'utf8');
    expect(summary).toContain('pass_with_warnings');
    expect(summary).toMatch(/F[A-Z0-9_-]+/);
    expect(
      `${readFileSync(files.output, 'utf8')}\n${summary}\n${allText(path.join(project, '.veritas'))}`,
    ).not.toContain('ghp_fake');
  });

  it('fails deep verification after accepting the discount property', async () => {
    const project = copyFixture();
    const base = git(project, 'rev-parse', 'HEAD');
    configure(project, base);
    await main();
    const property = listProperties(project).properties.find((item) => /discount/i.test(item.description));
    expect(property).toBeTruthy();
    await decideProperty(project, property?.id as string, 'accept', {
      actor: 'github-action-test',
      reason: 'matches the README contract',
    });
    const files = configure(project, base, { profile: 'deep' });
    expect(await main()).toBe(1);
    const values = outputValues(files.output);
    expect(values.verdict).toBe('policy_failure');
    expect(Number(values['confirmed-findings'])).toBeGreaterThanOrEqual(1);
  });

  it('does not pass silently when an accepted property has a solver timeout', async () => {
    const project = copyFixture();
    const base = git(project, 'rev-parse', 'HEAD');
    configure(project, base);
    await main();
    const property = listProperties(project).properties.find((item) => /discount/i.test(item.description));
    expect(property).toBeTruthy();
    await decideProperty(project, property?.id as string, 'accept', {
      actor: 'github-action-test',
      reason: 'matches the README contract',
    });
    const configPath = path.join(project, '.veritas/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.formal = { ...(config.formal as Record<string, unknown>), maxSolverMs: 1 };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const files = configure(project, base, { profile: 'deep', inconclusive: 'fail' });
    const code = await main();
    const values = outputValues(files.output);
    expect(values.verdict).not.toBe('pass');
    const reportPath = values['report-path'];
    expect(reportPath).toBeTruthy();
    const run = JSON.parse(readFileSync(path.join(project, reportPath as string), 'utf8')) as {
      policyReasons?: string[];
    };
    if (run.policyReasons?.some((reason) => /timeout|unknown/i.test(reason)))
      expect(values.verdict).not.toBe('pass');
    expect(code).not.toBe(0);
  });

  it('skips a README-only change but runs a mixed change', async () => {
    const project = copyFixture();
    const base = git(project, 'rev-parse', 'HEAD');
    writeFileSync(
      path.join(project, 'README.md'),
      `${readFileSync(path.join(project, 'README.md'), 'utf8')}\nMore docs.\n`,
    );
    git(project, 'add', 'README.md');
    git(
      project,
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=fixture',
      'commit',
      '-qm',
      'docs',
    );
    let files = configure(project, base);
    expect(await main()).toBe(0);
    expect(outputValues(files.output).verdict).toBe('skipped');
    expect(readFileSync(files.summary, 'utf8')).toMatch(/documentation-only/);
    writeFileSync(
      path.join(project, 'src/pricing.ts'),
      `${readFileSync(path.join(project, 'src/pricing.ts'), 'utf8')}\n`,
    );
    git(project, 'add', 'src/pricing.ts');
    git(
      project,
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=fixture',
      'commit',
      '-qm',
      'mixed',
    );
    files = configure(project, base);
    expect(await main()).not.toBe(2);
    expect(outputValues(files.output).verdict).not.toBe('skipped');
  });

  it.each([
    ['warn', 0],
    ['fail', 4],
  ])('handles a repository without package.json with inconclusive=%s', async (behavior, expected) => {
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-action-empty-')));
    const base = git(project, 'init', '-q') && git(project, 'rev-parse', 'HEAD').trim();
    const files = configure(project, base, { inconclusive: behavior });
    expect(await main()).toBe(expected);
    expect(outputValues(files.output).verdict).toBe('inconclusive');
  });

  it('returns 2 and writes no Veritas files for pull_request_target', async () => {
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-action-target-')));
    const eventPath = path.join(project, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { head: { repo: { full_name: 'other/project' } } } }),
    );
    vi.stubEnv('GITHUB_EVENT_NAME', 'pull_request_target');
    vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
    vi.stubEnv('INPUT_WORKING_DIRECTORY', project);
    expect(await main()).toBe(2);
    expect(existsSync(path.join(project, '.veritas'))).toBe(false);
  });

  it('reports a repository without package.json as degraded, failing only when inconclusive results must fail', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'veritas-action-nopkg-'));
    writeFileSync(path.join(project, 'main.py'), 'print("not a node project")\n');
    git(project, 'init', '-q');
    git(project, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A');
    git(
      project,
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=fixture',
      'commit',
      '-qm',
      'base',
    );
    const base = git(project, 'rev-parse', 'HEAD');
    const warn = configure(project, base);
    expect(await main()).toBe(0);
    expect(outputValues(warn.output).verdict).toBe('inconclusive');
    expect(readFileSync(warn.summary, 'utf8')).toMatch(/Degraded: no package\.json found/);
    const strict = configure(project, base, { inconclusive: 'fail' });
    expect(await main()).toBe(4);
    expect(outputValues(strict.output)['exit-code']).toBe('4');
    expect(existsSync(path.join(project, '.veritas'))).toBe(false);
  });
});
