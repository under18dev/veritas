import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitConfiguresFilters, gitOutput, gitRun } from '../src/index.js';

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', args, { cwd, stdio: 'ignore' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
}

/** A repository whose own configuration names a file system monitor that leaves a marker file when it runs. */
function hostileRepository(): { repo: string; marker: string } {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-hostile-')));
  const marker = path.join(repo, '..', `${path.basename(repo)}-fsmonitor-ran`);
  git(repo, 'init', '-q');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  const hook = path.join(repo, 'monitor.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);
  git(repo, 'config', 'core.fsmonitor', hook);

  return { repo, marker };
}

describe.skipIf(process.platform === 'win32')('git calls', () => {
  it('never start a file system monitor the repository configures', () => {
    const { repo, marker } = hostileRepository();
    // Plain git does run it: the repository is hostile as intended.
    spawnSync('git', ['ls-files'], { cwd: repo, stdio: 'ignore' });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(gitOutput(repo, ['ls-files'])).toBe('a.txt\n');
    expect(gitOutput(repo, ['rev-parse', '--show-toplevel'])?.trim()).toBe(repo);
    expect(gitRun(repo, ['check-ignore', '-q', '--', path.join(repo, 'a.txt')]).status).toBe(1);
    expect(gitOutput(repo, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', '--'])).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuse a diff of the working tree when the repository configures a content filter', () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-filter-')));
    git(repo, 'init', '-q');
    expect(gitConfiguresFilters(repo)).toBe(false);
    expect(gitOutput(repo, ['diff', '--name-only', '--'], { worktreeContent: true })).toBe('');
    git(repo, 'config', 'filter.evil.clean', 'touch ran');
    expect(gitConfiguresFilters(repo)).toBe(true);
    expect(gitOutput(repo, ['diff', '--name-only', '--'], { worktreeContent: true })).toBeNull();
    // Other commands do not read file contents through filters and still run.
    expect(gitOutput(repo, ['rev-parse', '--show-toplevel'])?.trim()).toBe(repo);
  });
});
