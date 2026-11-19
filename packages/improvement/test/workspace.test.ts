import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
