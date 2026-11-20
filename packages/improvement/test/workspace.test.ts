import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWorkspace,
  diffSnapshots,
  projectHash,
  removeWorkspace,
  snapshotTree,
  undoWrites,
  writeNewFiles,
} from '../src/index.js';
import { project } from './helpers.js';

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
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('veritas-improve-')).length;
    expect(() => createWorkspace(root)).toThrow(/links outside the project/);
    // The partial copy is removed.
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith('veritas-improve-')).length).toBe(before);
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
});
