import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type PatchFile, validatePatch } from '../src/index.js';
import { project } from './helpers.js';

const RULES = { testInclude: ['**/*.{test,spec}.{ts,tsx,js,mjs}'], maxPatchFiles: 2 };
const GOOD = "import { expect, it } from 'vitest';\nit('x', () => {\n  expect(1).toBe(1);\n});\n";
const add = (p: string, content = GOOD): PatchFile => ({ operation: 'add', path: p, content });

function repo(): string {
  return project({ 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': GOOD, 'README.md': '# x\n' });
}

describe('patch validation', () => {
  it('accepts a new test file inside the project', () => {
    expect(validatePatch(repo(), [add('test/veritas-P-1.test.ts')], RULES)).toEqual([]);
  });

  it('rejects editing an existing test file', () => {
    const root = repo();
    expect(validatePatch(root, [add('test/a.test.ts')], RULES).join()).toMatch(/already exists/);
    expect(
      validatePatch(root, [{ operation: 'modify', path: 'test/a.test.ts', content: GOOD }], RULES).join(),
    ).toMatch(/operation "modify"/);
  });

  it('rejects deleting a file', () => {
    expect(
      validatePatch(repo(), [{ operation: 'delete', path: 'test/a.test.ts', content: '' }], RULES).join(),
    ).toMatch(/operation "delete"/);
  });

  it.each([
    ['only', "it.only('x', () => {});"],
    ['skip', "it.skip('x', () => {});"],
    ['todo', "it.todo('x');"],
    ['describe.skip', "describe.skip('x', () => {});"],
    ['skipIf', "it.skipIf(true)('x', () => {});"],
    ['xit', "xit('x', () => {});"],
    ['fit', "fit('x', () => {});"],
    ['skip option', "test('x', { skip: true }, () => {});"],
    ['todo option with a reason', "it('x', { todo: 'later' }, () => {});"],
    ['only option', "test('x', { timeout: 10, only: true }, () => {});"],
    ['shorthand option', "const skip = true;\ntest('x', { skip }, () => {});"],
    ['string key option', "test('x', { 'todo': 'later' }, () => {});"],
    ['computed literal key', "test('x', { ['only']: true }, () => {});"],
    ['computed key', "const key = 'skip';\ntest('x', { [key]: true }, () => {});"],
    ['spread options', "const options = { skip: true };\ntest('x', { ...options }, () => {});"],
    ['bracket member', "it['skip']('x', () => {});"],
  ])('rejects a %s marker', (_name, content) => {
    expect(validatePatch(repo(), [add('test/veritas-x.test.ts', content)], RULES).join()).toMatch(
      /skip\/only\/todo/,
    );
  });

  it('rejects non-test paths and README files', () => {
    const root = repo();
    expect(validatePatch(root, [add('src/b.ts')], RULES).join()).toMatch(/not a test file/);
    expect(validatePatch(root, [add('README.md')], RULES).join()).toMatch(/README/);
    expect(validatePatch(root, [add('docs/readme.test.ts')], RULES).join()).toMatch(/README/);
    expect(validatePatch(root, [add('node_modules/x.test.ts')], RULES).join()).toMatch(/never patched/);
  });

  it('rejects traversal and absolute paths', () => {
    const root = repo();

    for (const p of [
      '../evil.test.ts',
      'test/../../evil.test.ts',
      '/tmp/evil.test.ts',
      'C:/evil.test.ts',
      'test\\x.test.ts',
      './a.test.ts',
    ]) {
      expect(validatePatch(root, [add(p)], RULES).join(), p).toMatch(/normalized relative path/);
    }
  });

  it('rejects a symlinked directory that escapes the project', () => {
    const root = repo();
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-outside-')));
    mkdirSync(path.join(outside, 'sub'));
    symlinkSync(outside, path.join(root, 'linked'));
    expect(validatePatch(root, [add('linked/sub/evil.test.ts')], RULES).join()).toMatch(
      /escapes the project root/,
    );
  });

  it('enforces the file budget, duplicates and empty patches', () => {
    const root = repo();
    expect(validatePatch(root, [], RULES).join()).toMatch(/no file/);
    expect(
      validatePatch(
        root,
        [add('test/a1.test.ts'), add('test/a2.test.ts'), add('test/a3.test.ts')],
        RULES,
      ).join(),
    ).toMatch(/maxPatchFiles/);
    expect(validatePatch(root, [add('test/a1.test.ts'), add('test/a1.test.ts')], RULES).join()).toMatch(
      /more than once/,
    );
  });
});
