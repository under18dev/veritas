import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  diffSnapshots,
  isPrivateGroup,
  projectHash,
  removeStaleWorkspaces,
  removeWorkspace,
  snapshotTree,
  statTree,
  statWorkspaceModules,
  undoWrites,
  unexpectedChanges,
  workspaceBase,
  workspaceMachine,
  writeNewFiles,
} from '../src/index.js';
import { project } from './helpers.js';

const DIR = process.platform === 'win32' ? 'junction' : 'dir';

describe('workspace and repository writes', () => {
  it('copies the project without tool state and links each installed package', () => {
    const root = project({ 'src/a.ts': 'x', '.veritas/runs/r/x.json': '{}', '.git/HEAD': 'ref' });
    mkdirSync(path.join(root, 'node_modules/dep'), { recursive: true });
    const ws = createWorkspace(root);

    try {
      expect(readFileSync(path.join(ws, 'src/a.ts'), 'utf8')).toBe('x');
      expect(existsSync(path.join(ws, '.veritas'))).toBe(false);
      expect(existsSync(path.join(ws, '.git'))).toBe(false);
      // node_modules is a real directory, so caches written there stay in the workspace; packages are links.
      expect(lstatSync(path.join(ws, 'node_modules')).isSymbolicLink()).toBe(false);
      expect(lstatSync(path.join(ws, 'node_modules/dep')).isSymbolicLink()).toBe(true);
      writeFileSync(path.join(ws, 'node_modules/.cache-marker'), 'x');
      expect(existsSync(path.join(root, 'node_modules/.cache-marker'))).toBe(false);
      writeFileSync(path.join(ws, 'src/a.ts'), 'changed');
      expect(readFileSync(path.join(root, 'src/a.ts'), 'utf8')).toBe('x');
    } finally {
      removeWorkspace(ws);
    }
    expect(existsSync(ws)).toBe(false);
  });

  it('refuses a project with a link leaving it, which the isolated run could write through', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'veritas-outside-'));
    writeFileSync(path.join(outside, 'shared.test.ts'), 'outside');
    const root = project({ 'src/a.ts': 'x' });
    symlinkSync(outside, path.join(root, 'test'), process.platform === 'win32' ? 'junction' : 'dir');
    // A cache directory of its own, so workspaces of tests running in parallel do not count.
    const temp = useCacheDir();
    try {
      expect(() => createWorkspace(root)).toThrow(/links outside the project/);
      // The partial copy and its owner record are removed.
      expect(readdirSync(path.join(temp, 'veritas/improve'))).toEqual([]);
    } finally {
      releaseCacheDir(temp);
    }
  });

  it('keeps links that stay inside the copy', () => {
    const root = project({ 'src/a.ts': 'x' });
    let linked = true;
    try {
      symlinkSync('src', path.join(root, 'lib'), 'dir');
    } catch {
      // Relative directory links need extra privileges on some Windows runners.
      linked = false;
    }
    const ws = createWorkspace(root);
    try {
      if (linked) expect(readFileSync(path.join(ws, 'lib/a.ts'), 'utf8')).toBe('x');
      expect(readFileSync(path.join(ws, 'src/a.ts'), 'utf8')).toBe('x');
    } finally {
      removeWorkspace(ws);
    }
  });

  it('creates files exclusively and removes everything it wrote when one write fails', () => {
    const root = project({ 'test/existing.test.ts': 'keep' });
    const hash = projectHash(root);
    expect(() =>
      writeNewFiles(root, [
        { operation: 'add', path: 'test/new/a.test.ts', content: 'a' },
        { operation: 'add', path: 'test/existing.test.ts', content: 'overwrite' },
      ]),
    ).toThrow(/EEXIST/);
    expect(readFileSync(path.join(root, 'test/existing.test.ts'), 'utf8')).toBe('keep');
    expect(existsSync(path.join(root, 'test/new'))).toBe(false);
    expect(projectHash(root)).toBe(hash);
  });

  it('reports exactly the added files and can undo them', () => {
    const root = project({ 'src/a.ts': 'x' });
    const before = snapshotTree(root);
    const record = writeNewFiles(root, [{ operation: 'add', path: 'test/deep/a.test.ts', content: 'a' }]);
    expect(diffSnapshots(before, snapshotTree(root))).toEqual(['test/deep/a.test.ts']);
    expect(undoWrites(record)).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(root))).toEqual([]);
    expect(existsSync(path.join(root, 'test'))).toBe(false);
  });

  it('accepts only the planned files with their exact content as changes', () => {
    const root = project({ 'src/a.ts': 'x', 'test/a.test.ts': 't' });
    const before = snapshotTree(root);
    const files = [{ operation: 'add' as const, path: 'test/veritas-p.test.ts', content: 'planned' }];
    writeNewFiles(root, files);
    expect(unexpectedChanges(before, snapshotTree(root), files)).toEqual([]);
    // Without the plan, the added file is a change; a planned file that is missing or differs is one too.
    expect(unexpectedChanges(before, snapshotTree(root), [])).toEqual(['test/veritas-p.test.ts']);
    writeFileSync(path.join(root, 'test/veritas-p.test.ts'), 'rewritten');
    appendFileSync(path.join(root, 'test/a.test.ts'), '// changed');
    mkdirSync(path.join(root, 'test/__snapshots__'));
    writeFileSync(path.join(root, 'test/__snapshots__/a.test.ts.snap'), '');
    expect(unexpectedChanges(before, snapshotTree(root), files)).toEqual([
      'test/__snapshots__/a.test.ts.snap',
      'test/a.test.ts',
      'test/veritas-p.test.ts',
    ]);
  });

  it('notices a file rewritten and restored, and empty directories, through metadata', () => {
    const root = project({ 'src/a.ts': 'x' });
    const before = statTree(root);
    const file = path.join(root, 'src/a.ts');
    const { atime, mtime } = statSync(file);
    writeFileSync(file, 'y');
    writeFileSync(file, 'x');
    utimesSync(file, atime, mtime);
    mkdirSync(path.join(root, 'src/empty'));
    // Tool output in ignored directories does not count.
    mkdirSync(path.join(root, '.veritas/runs'), { recursive: true });
    writeFileSync(path.join(root, '.veritas/runs/x.json'), '{}');
    expect(diffSnapshots(before, statTree(root))).toEqual(['src/a.ts', 'src/empty']);
    expect(diffSnapshots(snapshotTree(root), snapshotTree(root))).toEqual([]);
  });

  it("notices a package of the copy's node_modules swapped for another, which the runner is resolved from", () => {
    const store = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-store-')));
    const real = path.join(store, 'node_modules/.pnpm/mut@1/node_modules/@mizchi/mutator');
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, 'package.json'), '{"name":"@mizchi/mutator","bin":"cli.js"}');
    mkdirSync(path.join(store, 'node_modules/vitest'));
    const root = project({ 'src/a.ts': 'x' });
    mkdirSync(path.join(root, 'node_modules/@mizchi'), { recursive: true });
    symlinkSync(real, path.join(root, 'node_modules/@mizchi/mutator'), DIR);
    symlinkSync(path.join(store, 'node_modules/vitest'), path.join(root, 'node_modules/vitest'), DIR);
    const ws = createWorkspace(root);

    try {
      const before = statWorkspaceModules(ws);
      expect([...before.keys()]).toEqual(
        expect.arrayContaining(['node_modules', 'node_modules/@mizchi/mutator', 'node_modules/vitest']),
      );
      // Caches the tools write while they run do not count.
      mkdirSync(path.join(ws, 'node_modules/.vite/vitest'), { recursive: true });
      expect(diffSnapshots(before, statWorkspaceModules(ws))).toEqual([]);
      // A fake package in place of the link, a link re-created to the same place, and a new package all count.
      const link = path.join(ws, 'node_modules/@mizchi/mutator');
      unlinkSync(link);
      mkdirSync(link);
      writeFileSync(path.join(link, 'package.json'), '{"name":"@mizchi/mutator","bin":"cli.js"}');
      unlinkSync(path.join(ws, 'node_modules/vitest'));
      symlinkSync(path.join(store, 'node_modules/vitest'), path.join(ws, 'node_modules/vitest'), DIR);
      mkdirSync(path.join(ws, 'node_modules/shadow'));
      expect(diffSnapshots(before, statWorkspaceModules(ws))).toEqual([
        'node_modules/@mizchi/mutator',
        'node_modules/shadow',
        'node_modules/vitest',
      ]);
    } finally {
      removeWorkspace(ws);
    }
  });

  it("makes copies in the user's cache directory, private to the user, not in the shared temporary directory", () => {
    const cache = useCacheDir();
    try {
      const ws = createWorkspace(project({ 'src/a.ts': 'x' }));
      try {
        expect(path.dirname(ws)).toBe(realpathSync(path.join(cache, 'veritas/improve')));
        if (process.platform !== 'win32') {
          expect(statSync(path.dirname(ws)).mode & 0o077).toBe(0);
          expect(statSync(ws).mode & 0o077).toBe(0);
        }
      } finally {
        removeWorkspace(ws);
      }
      expect(readdirSync(path.join(cache, 'veritas/improve'))).toEqual([]);
    } finally {
      releaseCacheDir(cache);
    }
  });

  it('refuses a cache directory inside the project, or below a directory others can write to', () => {
    const root = project({ 'src/a.ts': 'x' });
    vi.stubEnv('XDG_CACHE_HOME', path.join(root, '.cache'));
    vi.stubEnv('LOCALAPPDATA', path.join(root, '.cache'));
    try {
      expect(() => createWorkspace(root)).toThrow(/inside the project/);
      // Refused before anything is created there.
      expect(existsSync(path.join(root, '.cache'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }

    if (process.platform === 'win32') return;
    const cache = useCacheDir();
    try {
      // Like a shared temporary directory: writable by others, sticky or not.
      const shared = path.join(cache, 'shared');
      mkdirSync(shared);
      chmodSync(shared, 0o1777);
      vi.stubEnv('XDG_CACHE_HOME', path.join(shared, 'cache'));
      expect(() => createWorkspace(root)).toThrow(/can be written by every user/);
      // Writable by a group shared with others (macOS's staff): refused, with the fix.
      if (process.platform === 'darwin') {
        const grouped = path.join(cache, 'grouped');
        mkdirSync(grouped);
        chmodSync(grouped, 0o770);
        vi.stubEnv('XDG_CACHE_HOME', path.join(grouped, 'cache'));
        expect(() => createWorkspace(root)).toThrow(/not your private group; run `chmod g-w /);
      }
    } finally {
      releaseCacheDir(cache);
    }
  });

  it("takes a group as private only when it is the user's own, with no other members or accounts", () => {
    const user = { username: 'ann', uid: 1000, gid: 1000 };
    const passwd =
      'root:x:0:0::/root:/bin/sh\nann:x:1000:1000::/home/ann:/bin/bash\nbob:x:1001:1001::/home/bob:/bin/bash\n';
    const group = 'root:x:0:\nann:x:1000:\nbob:x:1001:\nstaff:x:50:ann,bob\n';
    expect(isPrivateGroup(1000, user, { group, passwd })).toBe(true);
    // Not the user's primary group, a shared group, another member, or another account with it as primary group.
    expect(isPrivateGroup(1001, user, { group, passwd })).toBe(false);
    expect(isPrivateGroup(50, { ...user, gid: 50 }, { group, passwd })).toBe(false);
    expect(
      isPrivateGroup(1000, user, { group: group.replace('ann:x:1000:', 'ann:x:1000:bob'), passwd }),
    ).toBe(false);
    expect(
      isPrivateGroup(1000, user, { group, passwd: `${passwd}eve:x:1002:1000::/home/eve:/bin/sh\n` }),
    ).toBe(false);
    // Unknown to the files (a directory service): not taken as private.
    expect(isPrivateGroup(1000, user, { group: '', passwd })).toBe(false);
  });

  it('removes a partial copy when copying fails', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = project({ 'src/a.ts': 'x', 'secret/.env': 'TOKEN=1' });
    chmodSync(path.join(root, 'secret/.env'), 0o000);
    const cache = useCacheDir();
    try {
      expect(() => createWorkspace(root)).toThrow(/EACCES/);
      expect(readdirSync(path.join(cache, 'veritas/improve'))).toEqual([]);
    } finally {
      chmodSync(path.join(root, 'secret/.env'), 0o600);
      releaseCacheDir(cache);
    }
  });

  it('removes copies left by an apply that is gone, never one that is running', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'veritas-stale-'));
    const now = Date.now();
    const copy = (name: string, owner: object | null, ageMs = 0) => {
      const dir = path.join(base, `veritas-improve-${name}`);
      mkdirSync(dir);
      if (owner) writeFileSync(`${dir}.owner`, JSON.stringify(owner));
      const time = new Date(now - ageMs);
      utimesSync(dir, time, time);
      return dir;
    };
    const dead = spawnSync(process.execPath, ['-e', '']).pid as number;
    const day = 24 * 60 * 60 * 1000;
    const here = workspaceMachine();
    const gone = copy('dead00', { pid: dead, ...here });
    const running = copy('alive0', { pid: process.pid, ...here }, 30 * day);
    // Same host name, but another boot or pid namespace (a container): its process cannot be checked from here.
    const container = copy('cntnr1', { pid: dead, ...here, pidNamespace: 'pid:[1]' }, day);
    const foreignFresh = copy('frgn01', { pid: 1, host: 'other-host' }, day);
    const foreignOld = copy('frgn02', { pid: 1, host: 'other-host' }, 8 * day);
    const unownedFresh = copy('noown1', null, 60_000);
    const unownedOld = copy('noown2', null, 2 * day);
    writeFileSync(path.join(base, 'veritas-improve-orphan.owner'), '{}');
    writeFileSync(path.join(base, 'unrelated'), '');
    expect(removeStaleWorkspaces(base, now).sort()).toEqual([gone, foreignOld, unownedOld].sort());
    expect(readdirSync(base).sort()).toEqual(
      [
        path.basename(running),
        `${path.basename(running)}.owner`,
        path.basename(container),
        `${path.basename(container)}.owner`,
        path.basename(foreignFresh),
        `${path.basename(foreignFresh)}.owner`,
        path.basename(unownedFresh),
        'unrelated',
      ].sort(),
    );
  });
});

/** Point the cache directory to a new private one under the real cache directory, whose parents are safe. */
function useCacheDir(): string {
  const parent = path.dirname(path.dirname(workspaceBase()));
  mkdirSync(parent, { recursive: true });
  const cache = mkdtempSync(path.join(parent, 'veritas-test-'));
  for (const name of ['XDG_CACHE_HOME', 'LOCALAPPDATA']) vi.stubEnv(name, cache);

  return cache;
}

function releaseCacheDir(cache: string): void {
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
}
