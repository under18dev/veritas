import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspace, diffDependencies, removeWorkspace, snapshotDependencies } from '../src/index.js';
import { project } from './helpers.js';

const DIR = process.platform === 'win32' ? 'junction' : 'dir';

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * A project laid out like a pnpm monorepo member: its packages link into a `.pnpm` store in the project, plus a
 * workspace package outside the project whose own dependency links into a second store.
 */
function linkedProject(): { root: string; outside: string; store: string } {
  const root = project({ 'src/a.ts': 'x' });
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-deps-')));
  const outside = path.join(temp, 'packages/shared');
  const store = path.join(temp, 'node_modules/.pnpm/dep@1.0.0/node_modules/dep');
  const a = path.join(root, 'node_modules/.pnpm/a@1.0.0/node_modules/a');
  write(path.join(a, 'index.js'), 'export const a = 1;');
  write(path.join(root, 'node_modules/.pnpm/b@1.0.0/node_modules/b/index.js'), 'export const b = 1;');
  // b is a dependency of a, next to it in the store; the project does not link it directly.
  symlinkSync(
    path.join(root, 'node_modules/.pnpm/b@1.0.0/node_modules/b'),
    path.join(root, 'node_modules/.pnpm/a@1.0.0/node_modules/b'),
    DIR,
  );
  symlinkSync(a, path.join(root, 'node_modules/a'), DIR);
  write(path.join(outside, 'index.js'), 'export const shared = 1;');
  write(path.join(store, 'index.js'), 'export const dep = 1;');
  mkdirSync(path.join(outside, 'node_modules'));
  symlinkSync(store, path.join(outside, 'node_modules/dep'), DIR);
  // A link back to the package itself must not make the walk loop.
  symlinkSync(outside, path.join(outside, 'node_modules/self'), DIR);
  symlinkSync(path.join(temp, 'missing'), path.join(outside, 'node_modules/dangling'), DIR);
  symlinkSync(outside, path.join(root, 'node_modules/shared'), DIR);

  return { root, outside, store };
}

describe('snapshotDependencies', () => {
  it('covers the store, linked packages outside the project and their own linked dependencies', () => {
    const { root, outside, store } = linkedProject();
    const snapshot = snapshotDependencies(root);
    const paths = [...snapshot.keys()];
    expect(paths).toContain(path.join(root, 'node_modules/.pnpm/a@1.0.0/node_modules/a/index.js'));
    expect(paths).toContain(path.join(root, 'node_modules/.pnpm/b@1.0.0/node_modules/b/index.js'));
    expect(paths).toContain(path.join(outside, 'index.js'));
    expect(paths).toContain(path.join(store, 'index.js'));
    // The project's own files are not dependencies.
    expect(paths.some((p) => p.startsWith(path.join(root, 'src')))).toBe(false);
    expect(diffDependencies(snapshot, snapshotDependencies(root))).toEqual([]);
  });

  it('detects writes through the workspace links, including a rewrite that restores content and time', () => {
    const { root, outside, store } = linkedProject();
    const ws = createWorkspace(root);

    try {
      const before = snapshotDependencies(root);
      // Each write goes through a link of the workspace, as code run there would.
      writeFileSync(path.join(ws, 'node_modules/a/index.js'), 'export const a = 2;');
      // b, as a resolves it: next to a's real location.
      writeFileSync(path.join(realpathSync(path.join(ws, 'node_modules/a')), '../b/added.js'), '');
      writeFileSync(path.join(ws, 'node_modules/shared/node_modules/dep/index.js'), 'export const dep = 2;');
      const sharedFile = path.join(ws, 'node_modules/shared/index.js');
      const original = readFileSync(sharedFile);
      const { atime, mtime } = statSync(sharedFile);
      writeFileSync(sharedFile, 'tampered');
      writeFileSync(sharedFile, original);
      utimesSync(sharedFile, atime, mtime);
      expect(diffDependencies(before, snapshotDependencies(root))).toEqual(
        [
          path.join(root, 'node_modules/.pnpm/a@1.0.0/node_modules/a/index.js'),
          path.join(root, 'node_modules/.pnpm/b@1.0.0/node_modules/b/added.js'),
          path.join(outside, 'index.js'),
          path.join(store, 'index.js'),
        ].sort(),
      );
    } finally {
      removeWorkspace(ws);
    }
  });

  it('ignores tool caches at the top of node_modules and caches the workspace keeps to itself', () => {
    const { root } = linkedProject();
    const ws = createWorkspace(root);

    try {
      const before = snapshotDependencies(root);
      write(path.join(root, 'node_modules/.vite/deps/x.js'), 'cache');
      write(path.join(ws, 'node_modules/.vite/vitest/results.json'), '{}');
      expect(diffDependencies(before, snapshotDependencies(root))).toEqual([]);
    } finally {
      removeWorkspace(ws);
    }
  });

  it('walks a hidden store only when a package links into it', () => {
    const root = project({ 'src/a.ts': 'x' });
    const pkg = path.join(root, 'node_modules/.bun/c@1.0.0/node_modules/c');
    write(path.join(pkg, 'index.js'), 'export const c = 1;');
    write(path.join(root, 'node_modules/.cache/tool/state.json'), '{}');
    // The link comes after the store in directory order, so the store is skipped first and walked afterwards.
    symlinkSync(pkg, path.join(root, 'node_modules/c'), DIR);
    const paths = [...snapshotDependencies(root).keys()];
    expect(paths).toContain(path.join(pkg, 'index.js'));
    expect(paths.some((p) => p.includes(`${path.sep}.cache${path.sep}`))).toBe(false);
  });

  it('ignores a hard link added to a store file elsewhere, which only changes its link count and change time', () => {
    const { root } = linkedProject();
    const before = snapshotDependencies(root);
    const other = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-other-')));
    // Another project importing the same file from a content-addressed store.
    linkSync(
      path.join(root, 'node_modules/.pnpm/a@1.0.0/node_modules/a/index.js'),
      path.join(other, 'index.js'),
    );
    expect(diffDependencies(before, snapshotDependencies(root))).toEqual([]);
  });

  it('leaves out hidden entries of a package linked from outside node_modules, but not its build output', () => {
    const { root, outside } = linkedProject();
    write(path.join(outside, '.git/HEAD'), 'ref: refs/heads/main');
    write(path.join(outside, 'dist/index.js'), 'export const shared = 1;');
    const before = snapshotDependencies(root);
    expect([...before.keys()].some((p) => p.includes(`${path.sep}.git`))).toBe(false);
    // git and tools write repository state; a rebuilt dist is different code for the copy.
    write(path.join(outside, '.git/index'), 'index');
    write(path.join(outside, '.turbo/cache'), 'x');
    expect(diffDependencies(before, snapshotDependencies(root))).toEqual([]);
    writeFileSync(path.join(outside, 'dist/index.js'), 'export const shared = 2;');
    expect(diffDependencies(before, snapshotDependencies(root))).toEqual([
      path.join(outside, 'dist/index.js'),
    ]);
  });

  it('follows links inside a linked package outside node_modules, such as a source directory linked from elsewhere', () => {
    const root = project({ 'src/a.ts': 'x' });
    const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-linked-src-')));
    // node_modules/shared -> <repo>/shared, and <repo>/shared/src -> <repo>/source.
    write(path.join(repo, 'source/index.js'), 'export const shared = 1;');
    write(path.join(repo, 'shared/package.json'), '{"name":"shared"}');
    symlinkSync(path.join(repo, 'source'), path.join(repo, 'shared/src'), DIR);
    // A cycle back to the package must not make the walk loop.
    symlinkSync(path.join(repo, 'shared'), path.join(repo, 'source/back'), DIR);
    mkdirSync(path.join(root, 'node_modules'));
    symlinkSync(path.join(repo, 'shared'), path.join(root, 'node_modules/shared'), DIR);
    const ws = createWorkspace(root);

    try {
      const before = snapshotDependencies(root);
      writeFileSync(path.join(ws, 'node_modules/shared/src/index.js'), 'export const shared = 2;');
      expect(diffDependencies(before, snapshotDependencies(root))).toEqual([
        path.join(repo, 'source/index.js'),
      ]);
    } finally {
      removeWorkspace(ws);
    }
  });

  it('is empty for a project without node_modules', () => {
    expect(snapshotDependencies(project({ 'src/a.ts': 'x' })).size).toBe(0);
  });
});
