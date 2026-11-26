import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  gitConfiguresFilters,
  gitExecutable,
  gitOutput,
  gitPathEntries,
  gitRun,
  type LogEvent,
  withRunContext,
} from '../src/index.js';

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

  it('refuse a diff of the working tree when the worktree configuration names a filter', () => {
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-wtfilter-')));
    git(repo, 'init', '-q');
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(repo, 'config', '--worktree', 'filter.evil.clean', 'touch ran');
    expect(gitConfiguresFilters(repo)).toBe(true);
    expect(gitOutput(repo, ['diff', '--name-only', '--'], { worktreeContent: true })).toBeNull();
  });

  it('never look into submodules, whose own configuration may name a filter', () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-submodule-')));
    const marker = path.join(base, 'filter-ran');
    const sub = path.join(base, 'sub');
    const parent = path.join(base, 'parent');
    const commit = (cwd: string) =>
      git(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'c');
    git(base, 'init', '-q', sub);
    git(base, 'init', '-q', parent);
    writeFileSync(path.join(sub, 'f.txt'), 'one');
    writeFileSync(path.join(sub, '.gitattributes'), '* filter=evil\n');
    git(sub, 'add', '.');
    commit(sub);
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'm');
    commit(parent);
    // The submodule's own configuration (in the parent's .git/modules/m) names the filter; its file becomes dirty.
    git(path.join(parent, 'm'), 'config', 'filter.evil.clean', `touch '${marker}'; cat`);
    writeFileSync(path.join(parent, 'm', 'f.txt'), 'two');
    // Plain git runs it: the layout is hostile as intended.
    spawnSync('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: parent, stdio: 'ignore' });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // .gitmodules asks for the submodule to be looked into, which overrides diff.ignoreSubmodules from -c.
    git(parent, 'config', '-f', '.gitmodules', 'submodule.m.ignore', 'none');
    spawnSync('git', ['-c', 'diff.ignoreSubmodules=all', 'diff', '--name-only', 'HEAD', '--'], {
      cwd: parent,
      stdio: 'ignore',
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(gitConfiguresFilters(parent)).toBe(false);
    expect(
      gitOutput(parent, ['diff', '--name-only', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], {
        worktreeContent: true,
      }),
    ).toBe('.gitmodules\n'); // the changed .gitmodules, never the dirty submodule
    expect(existsSync(marker)).toBe(false);
  });
});

describe('gitExecutable', () => {
  it('finds git on absolute PATH entries only, so never one in the working directory', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-path-')));
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    writeFileSync(path.join(dir, name), '');
    chmodSync(path.join(dir, name), 0o755);
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(gitExecutable({ env: { PATH: `.${sep}${sep}relative/bin${sep}${dir}` } })).toBe(
      path.join(dir, name),
    );
    // Relative and empty entries (the working directory) are never searched.
    expect(gitExecutable({ env: { PATH: `.${sep}${sep}relative/bin` } })).toBeNull();
    // Nor one inside the repository git would run in.
    expect(gitExecutable({ env: { PATH: dir }, excluded: [path.dirname(dir)] })).toBeNull();
  });

  it('skips node_modules directories, the repository and, on Windows, root-relative entries', () => {
    expect(
      gitPathEntries(
        [
          '',
          '.',
          'rel/bin',
          '/proj/node_modules/.bin',
          '/opt/node_modules/tool/bin',
          '/proj/tools',
          '/usr/bin',
        ].join(':'),
        'linux',
        ['/proj'],
      ),
    ).toEqual(['/usr/bin']);
    expect(
      gitPathEntries(
        [
          '\\bin',
          'D:rel',
          'C:\\Program Files\\Git\\cmd',
          '\\\\server\\share\\git',
          'C:\\proj\\node_modules\\.bin',
          'C:\\proj\\tools',
        ].join(';'),
        'win32',
        ['C:\\proj'],
      ),
    ).toEqual(['C:\\Program Files\\Git\\cmd', '\\\\server\\share\\git']);
  });

  it.skipIf(process.platform === 'win32')('compares excluded roots by real path', () => {
    const real = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-real-')));
    const links = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-links-')));
    mkdirSync(path.join(real, 'bin'));
    symlinkSync(real, path.join(links, 'proj'), 'dir');
    // The PATH entry goes through a link to the excluded root, and the other way round.
    expect(gitPathEntries(path.join(links, 'proj/bin'), process.platform, [real])).toEqual([]);
    expect(gitPathEntries(path.join(real, 'bin'), process.platform, [path.join(links, 'proj')])).toEqual([]);
  });
});

function fakeGit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'git'), '#!/bin/sh\necho fake-git\n');
  chmodSync(path.join(dir, 'git'), 0o755);
}

describe.skipIf(process.platform === 'win32')(
  'git next to a dotfiles repository in the home directory',
  () => {
    it("takes git from the user's own tools even when the home directory is a git repository", () => {
      const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-home-')));
      git(home, 'init', '-q');
      fakeGit(path.join(home, '.local/bin'));
      const project = path.join(home, 'project');
      mkdirSync(project);
      vi.stubEnv('HOME', home);
      vi.stubEnv('PATH', path.join(home, '.local/bin'));
      try {
        // The project has no .git of its own: the home repository does not count, so ~/.local/bin is not excluded.
        expect(gitRun(project, ['--version']).stdout).toBe('fake-git\n');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('warns, naming the directory and why, when the only git on PATH is one it does not take', async () => {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-warn-')));
      const bin = path.join(dir, 'node_modules/.bin');
      fakeGit(bin);
      const events: LogEvent[] = [];
      const found = await withRunContext({ sinks: [(e) => events.push(e)] }, async () =>
        gitExecutable({ env: { PATH: bin } }),
      );
      expect(found).toBeNull();
      const warning = events.find((e) => e.level === 'warn');
      expect(warning?.message).toContain(`git in ${bin} was not used: a node_modules directory`);
    });

    it('logs the warning about a git it does not take once per process', async () => {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-git-warn-once-')));
      const bin = path.join(dir, 'node_modules/.bin');
      const other = path.join(dir, 'other/node_modules/.bin');
      fakeGit(bin);
      fakeGit(other);
      const events: LogEvent[] = [];
      await withRunContext({ sinks: [(e) => events.push(e)] }, async () => {
        for (let i = 0; i < 5; i++) expect(gitExecutable({ env: { PATH: bin } })).toBeNull();
        // Another directory is another warning, logged once too.
        gitExecutable({ env: { PATH: other } });
        gitExecutable({ env: { PATH: other } });
      });
      const warnings = events.filter((e) => e.level === 'warn').map((e) => e.message);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(`git in ${bin} was not used`);
      expect(warnings[1]).toContain(`git in ${other} was not used`);
    });
  },
);
