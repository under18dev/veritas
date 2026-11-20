import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers.js';

const repo = REPO_ROOT;
const action = path.join(repo, 'packages/github-action/dist/main.js');
const fixture = path.join(repo, 'fixtures', 'discount-boundary');

/** Values a runner could hold for a pull request job; none may reach project code or any output. */
const SECRETS = {
  GITHUB_TOKEN: 'ghp_forkforkforkforkforkforkforkforkfork1234',
  ACTIONS_RUNTIME_TOKEN: 'actions-runtime-value-7c1e0a9b5d2f',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id-token-request-value-3f8a2c6e4b1d',
  SECRET: 'custom-secret-value-5e9d1b7a3c0f',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=fixture',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
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

/**
 * A fork pull request against the discount fixture: the base commit is the fixture, the head changes the source
 * (so mutation testing runs the project's tests) and adds a test file that records the environment it runs with.
 */
function forkPullRequest(probes: string): { project: string; base: string } {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-action-fork-')));
  cpSync(fixture, project, {
    recursive: true,
    filter: (source) => !source.includes('node_modules') && !source.includes('.mutator'),
  });
  const modules = path.join(fixture, 'node_modules');
  mkdirSync(path.join(project, 'node_modules'));

  for (const name of readdirSync(modules))
    symlinkSync(realpathSync(path.join(modules, name)), path.join(project, 'node_modules', name), 'junction');
  git(project, 'init', '-q');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'base');
  const base = git(project, 'rev-parse', 'HEAD');

  initProject(project);
  const configFile = path.join(project, '.veritas/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  // Network sources are enabled in the repository's configuration; the action must still stay offline.
  config.sources.github = { enabled: true, repo: 'org/project' };
  config.sources.web = { ...config.sources.web, enabled: true, allowDomains: ['example.com'] };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  writeFileSync(
    path.join(project, 'src/pricing.ts'),
    `${readFileSync(path.join(project, 'src/pricing.ts'), 'utf8')}\n`,
  );
  writeFileSync(
    path.join(project, 'test/env-probe.test.ts'),
    [
      "import { writeFileSync } from 'node:fs';",
      "import { expect, it } from 'vitest';",
      `writeFileSync(${JSON.stringify(probes)} + '/vitest-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json', JSON.stringify(process.env));`,
      "it('records the environment', () => expect(true).toBe(true));",
      '',
    ].join('\n'),
  );
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'pull request from a fork');

  return { project, base };
}

/** On POSIX, a `git` first on PATH that records its environment before running the real git. */
function gitRecorder(probes: string): string | null {
  if (process.platform === 'win32') return null;
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(probes, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nenv > "${probes}/git-$$.env"\nexec "${real}" "$@"\n`);
  chmodSync(path.join(bin, 'git'), 0o755);

  return bin;
}

describe('the built action on a pull request from a fork', { timeout: 300_000 }, () => {
  it('keeps secrets away from project code and every output, stays offline and still gives a verdict', () => {
    const probes = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-action-probes-')));
    const { project, base } = forkPullRequest(probes);
    const recorder = gitRecorder(probes);
    const eventPath = path.join(probes, 'event.json');
    const outputFile = path.join(probes, 'output.txt');
    const summaryFile = path.join(probes, 'summary.md');
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          base: { sha: base, repo: { full_name: 'org/project' } },
          head: { repo: { full_name: 'contributor/project' } },
        },
      }),
    );
    const result = spawnSync(process.execPath, [action], {
      cwd: project,
      encoding: 'utf8',
      timeout: 280_000,
      env: {
        PATH: recorder ? `${recorder}${path.delimiter}${process.env.PATH}` : process.env.PATH,
        HOME: process.env.HOME,
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: 'org/project',
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        INPUT_PROFILE: 'standard',
        INPUT_WORKING_DIRECTORY: project,
        INPUT_SUMMARY: 'true',
        ...SECRETS,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(outputFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split(/=(.*)/s, 2) as [string, string]),
    );
    expect(result.status, result.stderr).toBe(Number(outputs['exit-code']));
    expect(outputs.verdict).toMatch(/^(pass|pass_with_warnings)$/);
    expect(outputs['from-fork']).toBe('true');
    const summary = readFileSync(summaryFile, 'utf8');
    expect(summary).toContain(`Verdict: **${outputs.verdict}**`);
    expect(summary).toContain('Pull request from a fork: yes');

    // The run that was launched: mutation testing ran the project's tests, which recorded their environment.
    const runDir = path.join(project, '.veritas/runs', outputs['run-id'] as string);
    const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8')).data;
    expect(run.verdict).toBe(outputs.verdict);
    expect(run.stages.find((s: { stage: string }) => s.stage === 'mutate')?.status).toBe('succeeded');
    const dumps = readdirSync(probes).filter((f) => f.startsWith('vitest-'));
    expect(dumps.length).toBeGreaterThan(0);
    const gitDumps = readdirSync(probes).filter((f) => f.startsWith('git-'));

    if (recorder) expect(gitDumps.length).toBeGreaterThan(0);

    for (const file of [...dumps, ...gitDumps]) {
      const text = readFileSync(path.join(probes, file), 'utf8');

      for (const [name, value] of Object.entries(SECRETS)) {
        expect(text, `${file} has ${name}`).not.toContain(value);
        expect(text, `${file} has ${name}`).not.toMatch(new RegExp(`"?${name}"?\\s*[:=]`));
      }
    }

    // Offline although the configuration enables GitHub and web sources.
    const evidence = JSON.parse(readFileSync(path.join(runDir, 'evidence.json'), 'utf8')).data;
    expect(evidence.networkRequests).toBe(0);
    expect(evidence.skipped).toEqual(
      expect.arrayContaining([
        { source: 'github', reason: 'offline' },
        { source: 'web', reason: 'offline' },
      ]),
    );

    // No secret value in the action's output, step summary, logs or any artifact or report.
    const written = [
      readFileSync(outputFile, 'utf8'),
      summary,
      result.stdout,
      result.stderr,
      allText(path.join(project, '.veritas')),
    ].join('\n');

    for (const value of Object.values(SECRETS)) expect(written).not.toContain(value);
  });
});
