import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

describe('createServer', () => {
  it('refuses a root that does not exist or is a file, and a concurrency limit it cannot enforce', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'veritas-mcp-'));
    const file = path.join(dir, 'file.txt');
    writeFileSync(file, 'x');
    expect(() => createServer({ root: path.join(dir, 'missing') })).toThrow(/does not exist/);
    expect(() => createServer({ root: file })).toThrow(/not a directory/);
    for (const maxConcurrent of [0, 1.5, Number.NaN, 17])
      expect(() => createServer({ root: dir, maxConcurrent })).toThrow(/maxConcurrent/);
    expect(createServer({ root: dir, maxConcurrent: 2 })).toBeTruthy();
  });
});
