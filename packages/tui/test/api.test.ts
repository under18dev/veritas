import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApi, replaceFile } from '../src/api.js';

const temp = (name: string) => realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-tui-${name}-`)));

describe('writing the configuration', () => {
  it('replaces the file and leaves no temporary file behind', () => {
    const root = temp('write');
    mkdirSync(path.join(root, '.veritas'));
    writeFileSync(path.join(root, '.veritas/config.json'), '{}\n');
    createApi(root).writeConfig({ mutation: { timeoutMs: 5000 } });
    expect(JSON.parse(readFileSync(path.join(root, '.veritas/config.json'), 'utf8'))).toEqual({
      mutation: { timeoutMs: 5000 },
    });
    expect(readdirSync(path.join(root, '.veritas'))).toEqual(['config.json']);
  });

  it('never writes an invalid configuration', () => {
    const root = temp('invalid');
    mkdirSync(path.join(root, '.veritas'));
    writeFileSync(path.join(root, '.veritas/config.json'), '{}\n');
    expect(() => createApi(root).writeConfig({ mutation: { timeoutMs: -5 } })).toThrow(
      /invalid configuration/,
    );
    expect(readFileSync(path.join(root, '.veritas/config.json'), 'utf8')).toBe('{}\n');
  });

  it('replaces a link to a file outside the project instead of writing through it', () => {
    const root = temp('link');
    const outside = path.join(temp('outside'), 'target.json');
    writeFileSync(outside, 'unchanged');
    mkdirSync(path.join(root, '.veritas'));
    symlinkSync(outside, path.join(root, '.veritas/inner.json'));
    replaceFile(root, path.join(root, '.veritas/inner.json'), '{}');
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(lstatSync(path.join(root, '.veritas/inner.json')).isSymbolicLink()).toBe(false);
  });

  it('refuses a directory that resolves outside the project', () => {
    const root = temp('dir');
    const outside = temp('elsewhere');
    symlinkSync(outside, path.join(root, '.veritas'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => replaceFile(root, path.join(root, '.veritas/config.json'), '{}')).toThrow(
      /outside the project/,
    );
    expect(readdirSync(outside)).toEqual([]);
  });
});
