import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DiscoveryResult, discoverEvidence } from '../src/index.js';
import { config, tempProject } from './helpers.js';

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

describe('git history and reproducibility', () => {
  it('collects subjects and bodies from the last commits in a git repository', async () => {
    const root = tempProject('git');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'test');
    writeFileSync(`${root}/README.md`, 'The total must be at least 10.\n');
    git(root, 'add', 'README.md');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Document boundary');
    const result = await discoverEvidence({ root, config: config() });
    const commit = result.sources.find((source) => source.kind === 'git');
    expect(commit?.locator).toMatch(/^commit [0-9a-f]{12}$/);
    expect(commit?.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reads every commit whole, even when a message contains a separator-like line', async () => {
    const root = tempProject('git-separator');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'test');
    writeFileSync(`${root}/README.md`, 'Readme.\n');
    git(root, 'add', 'README.md');
    git(
      root,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'First',
      '-m',
      'before\n---\nThe total must be at least 10.',
    );
    writeFileSync(`${root}/B.txt`, 'b\n');
    git(root, 'add', 'B.txt');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Second');
    const result = await discoverEvidence({ root, config: config() });
    const commits = result.sources.filter((s) => s.kind === 'git');
    expect(commits).toHaveLength(2);
    expect(
      result.statements.some(
        (st) => st.quote.includes('at least 10') && commits.some((c) => c.id === st.sourceId),
      ),
    ).toBe(true);
  });

  it('keeps the id of a commit message source when later commits are added', async () => {
    const root = tempProject('git-stable');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'test');
    writeFileSync(`${root}/README.md`, 'Readme.\n');
    git(root, 'add', 'README.md');
    git(
      root,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Limit totals',
      '-m',
      'The total must be at least 10.',
    );
    const before = await discoverEvidence({ root, config: config() });
    writeFileSync(`${root}/OTHER.txt`, 'x\n');
    git(root, 'add', 'OTHER.txt');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Unrelated change');
    const after = await discoverEvidence({ root, config: config() });
    const limit = (r: typeof before) =>
      r.sources.find((s) => s.kind === 'git' && s.summary.includes('Limit totals'));
    expect(limit(before)?.id).toBeDefined();
    expect(limit(after)?.id).toBe(limit(before)?.id);
    const statement = (r: typeof before) =>
      r.statements.find((st) => st.quote.includes('at least 10') && st.sourceId === limit(r)?.id);
    expect(statement(after)?.id).toBe(statement(before)?.id);
  });

  it('reports a useful skip when the root is not a git repository', async () => {
    const result = await discoverEvidence({ root: tempProject('not-git'), config: config() });
    expect(result.skipped).toContainEqual({
      source: 'git',
      reason: 'not a git repository or git unavailable',
    });
  });

  it('keeps IDs independent of the absolute project path', async () => {
    const firstRoot = tempProject('same-a');
    const secondRoot = tempProject('same-b');
    mkdirSync(`${firstRoot}/docs`, { recursive: true });
    mkdirSync(`${secondRoot}/docs`, { recursive: true });
    writeFileSync(`${firstRoot}/README.md`, 'The total must be at least 10.\n');
    writeFileSync(`${secondRoot}/README.md`, 'The total must be at least 10.\n');
    writeFileSync(`${firstRoot}/docs/rule.md`, 'The limit should be less than 20.\n');
    writeFileSync(`${secondRoot}/docs/rule.md`, 'The limit should be less than 20.\n');
    const first = await discoverEvidence({
      root: firstRoot,
      config: config(),
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    const second = await discoverEvidence({
      root: secondRoot,
      config: config(),
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(first.sources.map(({ id, ...source }) => source)).toEqual(
      second.sources.map(({ id, ...source }) => source),
    );
    expect(first.statements.map(({ id, ...statement }) => statement)).toEqual(
      second.statements.map(({ id, ...statement }) => statement),
    );
    expect(first.sources.map((source) => source.id)).toEqual(second.sources.map((source) => source.id));
    expect(first.statements.map((statement) => statement.id)).toEqual(
      second.statements.map((statement) => statement.id),
    );
    expect(DiscoveryResult.parse(first)).toEqual(first);
  });
});
