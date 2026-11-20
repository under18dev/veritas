import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VeritasConfig } from '@under18dev/veritas-core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

describe('scope and diagnostics', () => {
  it('ignores files outside testInclude and does not crash on broken syntax', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/included.test.ts': `import { expect, test } from 'vitest'; import { value } from '../src/value.js'; test('included', () => expect(value(1)).toBe(1));`,
      'test/ignored.ts': `import { test } from 'vitest'; test('ignored', () => {});`,
      'test/broken.test.ts': `import { test } from 'vitest'; test('broken', () => {`,
    });
    const inventory = inventoryTests({ root, config: VeritasConfig.parse({}) });

    expect(inventory.tests.map((test) => test.name)).toContain('included');
    expect(inventory.tests.map((test) => test.name)).not.toContain('ignored');
    expect(inventory.diagnostics.some((diagnostic) => diagnostic.file === 'test/broken.test.ts')).toBe(true);
  });

  it('does not read test files through links that leave the project root', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'veritas-outside-'));
    writeFileSync(
      path.join(outside, 'external.test.ts'),
      `import { test } from 'vitest'; test('outside the root', () => {});`,
    );
    const root = tempProject({
      'test/inside.test.ts': `import { test } from 'vitest'; test('inside', () => {});`,
    });
    let linked = true;
    try {
      symlinkSync(path.join(outside, 'external.test.ts'), path.join(root, 'test/external.test.ts'), 'file');
    } catch {
      // Creating file links needs extra privileges on some Windows runners.
      linked = false;
    }
    const names = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests.map((test) => test.name);

    expect(names).toContain('inside');
    expect(names).not.toContain('outside the root');
    if (linked) expect(names).toEqual(['inside']);
  });

  it('marks a file whose code anywhere runs out of process or imports an unresolved module', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/helpers.ts': `import { spawnSync } from 'node:child_process'; export const cli = () => spawnSync('node', ['x']);`,
      'test/plain.test.ts': `import { expect, test } from 'vitest'; import { value } from '../src/value.js'; test('plain', () => expect(value(1)).toBe(1));`,
      'test/custom.test.ts': `
        import { expect, test } from 'vitest';
        import { spawnSync } from 'node:child_process';
        import { value } from '../src/value.js';
        test('recognized', () => expect(value(1)).toBe(1));
        const custom = (name: string, fn: () => void) => test(name, fn);
        custom('unrecognized', () => { spawnSync('node', ['other.js']); });
      `,
      'test/via-helper.test.ts': `import { test } from 'vitest'; import { cli } from './helpers.js'; test('cli', () => { cli(); });`,
      'test/missing.test.ts': `import { test } from 'vitest'; import { gone } from './gone.js'; test('gone', () => gone());`,
      'test/required.test.ts': `import { test } from 'vitest'; test('cjs', () => { require('../src/value.js'); });`,
      'test/created.test.ts': `import { test } from 'vitest'; import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); test('x', () => { load('../src/value.js'); });`,
    });
    const files = inventoryTests({ root, config: VeritasConfig.parse({}) }).files;
    const unseen = (name: string) => files.find((file) => file.path === name)?.unseenReach;
    expect(unseen('test/plain.test.ts')).toBe(false);
    expect(unseen('test/custom.test.ts')).toBe(true);
    expect(unseen('test/via-helper.test.ts')).toBe(true);
    expect(unseen('test/missing.test.ts')).toBe(true);
    expect(unseen('test/required.test.ts')).toBe(true);
    expect(unseen('test/created.test.ts')).toBe(true);
    // The same calls inside a test make it opaque, so its kills are not credited to the linked call alone.
    const tests = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests;
    expect(tests.find((t) => t.name === 'cjs')?.suspicions).toContain('opaque_call');
  });

  it('does not treat node or Vitest calls as project symbols', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/non-project.test.ts': `
        import { expect, test } from 'vitest';
        import path from 'node:path';
        test('non-project', () => { expect(path.basename('/x/y')).toBe('y'); });
      `,
    });
    const testCase = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests.at(0);

    if (!testCase) throw new Error('missing non-project test');

    expect(testCase.calledSymbols).toEqual([]);
    expect(testCase.targetCalls).toEqual([]);
  });
});

describe('tsconfig containment', () => {
  it('reads no configuration outside the project root', () => {
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-inventory-parent-')));
    writeFileSync(path.join(parent, 'tsconfig.json'), '{ "compilerOptions": {} }');
    writeFileSync(path.join(parent, 'base.json'), '{ "compilerOptions": {} }');
    const root = path.join(parent, 'project');
    mkdirSync(path.join(root, 'test'), { recursive: true });
    writeFileSync(path.join(root, 'test/a.test.ts'), "import { it } from 'vitest';\nit('a', () => {});\n");
    const read: string[] = [];
    const original = ts.sys.readFile;
    ts.sys.readFile = (name, encoding) => {
      read.push(path.resolve(name));

      return original(name, encoding);
    };

    try {
      // No tsconfig in the root: the parent's must not be picked up.
      inventoryTests({ root, config: VeritasConfig.parse({}) });
      writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: '../base.json' }));
      inventoryTests({ root, config: VeritasConfig.parse({ project: { tsconfig: 'tsconfig.json' } }) });
      inventoryTests({ root, config: VeritasConfig.parse({ project: { tsconfig: '../tsconfig.json' } }) });
    } finally {
      ts.sys.readFile = original;
    }
    expect(read.filter((f) => f.startsWith(parent + path.sep) && !f.startsWith(root + path.sep))).toEqual([]);
    expect(read).toContain(path.join(root, 'tsconfig.json'));
  });
});
