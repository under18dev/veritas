import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  projectHash,
  removeWorkspace,
  snapshotTree,
  statTree,
  statWorkspaceModules,
  undoWrites,
  unexpectedChanges,
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
    const temp = mkdtempSync(path.join(tmpdir(), 'veritas-temp-'));
    for (const name of ['XDG_CACHE_HOME', 'LOCALAPPDATA']) vi.stubEnv(name, temp);
    try {
      expect(() => createWorkspace(root)).toThrow(/links outside the project/);
      // The partial copy is removed.
      expect(readdirSync(path.join(temp, 'veritas/improve'))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
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
    const cache = mkdtempSync(path.join(tmpdir(), 'veritas-cache-'));
    for (const name of ['XDG_CACHE_HOME', 'LOCALAPPDATA']) vi.stubEnv(name, cache);
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
      vi.unstubAllEnvs();
    }
  });
});
