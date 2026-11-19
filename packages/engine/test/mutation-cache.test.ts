import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContentCache } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { mutationCacheKey } from '../src/index.js';

function project(git = true): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-mutation-cache-')));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'test'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }));
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = (x: number) => x > 1;\n');
  writeFileSync(path.join(root, 'test/a.test.ts'), "it('a', () => {});\n");
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

describe('mutation cache key', () => {
  const selection = { configHash: 'a'.repeat(64) };

  it('is stable for identical inputs and changes with sources, tests, config and scope', () => {
    const root = project();
    const cache = new ContentCache(root);
    const key = mutationCacheKey(cache, root, selection);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(mutationCacheKey(cache, root, selection)).toBe(key);
    // Run artifacts and the cache itself are not inputs.
    mkdirSync(path.join(root, '.veritas/runs'), { recursive: true });
    writeFileSync(path.join(root, '.veritas/runs/x.json'), '{}');
    expect(mutationCacheKey(cache, root, selection)).toBe(key);
    // Nor are tool state directories, even when they are not ignored.
    for (const dir of ['.mutator', 'node_modules/.vite']) {
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, 'state.json'), String(Math.random()));
    }
    expect(mutationCacheKey(cache, root, selection)).toBe(key);

    expect(mutationCacheKey(cache, root, { configHash: 'b'.repeat(64) })).not.toBe(key);
    expect(mutationCacheKey(cache, root, { ...selection, scope: ['src'] })).not.toBe(key);
    writeFileSync(path.join(root, 'test/a.test.ts'), "it('a', () => { expect(1).toBe(1); });\n");
    const afterTest = mutationCacheKey(cache, root, selection);
    expect(afterTest).not.toBe(key);
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = (x: number) => x >= 1;\n');
    expect(mutationCacheKey(cache, root, selection)).not.toBe(afterTest);
  });

  it('ignores files excluded by .gitignore but not new untracked files', () => {
    const root = project();
    const cache = new ContentCache(root);
    writeFileSync(path.join(root, '.gitignore'), 'build/\n');
    const key = mutationCacheKey(cache, root, selection);
    mkdirSync(path.join(root, 'build'));
    writeFileSync(path.join(root, 'build/out.js'), 'x');
    expect(mutationCacheKey(cache, root, selection)).toBe(key);
    writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 1;\n');
    expect(mutationCacheKey(cache, root, selection)).not.toBe(key);
  });

  it('is not available without git or with a --since reference that does not resolve', () => {
    const plain = project(false);
    expect(mutationCacheKey(new ContentCache(plain), plain, selection)).toBeNull();
    const root = project();
    expect(mutationCacheKey(new ContentCache(root), root, { ...selection, since: 'no-such-ref' })).toBeNull();
  });
});
