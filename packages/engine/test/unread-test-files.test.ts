import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VeritasConfig } from '@under18dev/veritas-core';
import { inventoryTests } from '@under18dev/veritas-test-inventory';
import { nodeTestRunner } from '@under18dev/veritas-test-runner-node';
import { describe, expect, it } from 'vitest';
import { listUnreadTestFiles, unreadTestFiles } from '../src/run.js';

type Fields = {
  unseenReach?: boolean;
  inexactNames?: 'open_collection' | 'imported_registrations';
  usesRunner?: boolean;
  foreignRunner?: string;
  packageCall?: string;
  loadsCode?: boolean;
};

const file = (path: string, fields: Fields = {}) => ({
  path,
  hash: 'h',
  dependencies: [],
  unseenReach: fields.unseenReach ?? false,
  ...(fields.inexactNames ? { inexactNames: fields.inexactNames } : {}),
  ...(fields.usesRunner !== undefined ? { usesRunner: fields.usesRunner } : {}),
  ...(fields.foreignRunner ? { foreignRunner: fields.foreignRunner } : {}),
  ...(fields.packageCall ? { packageCall: fields.packageCall } : {}),
  ...(fields.loadsCode !== undefined ? { loadsCode: fields.loadsCode } : {}),
});

const unreadOf = (files: ReturnType<typeof file>[]) =>
  unreadTestFiles({ tests: [{ file: 'test/read.test.ts' } as never], edges: [], files, diagnostics: [] });

describe('unreadTestFiles', () => {
  it('names the test files with no recorded test that static analysis could not read fully, with why', () => {
    const unread = unreadOf([
      file('test/read.test.ts', { inexactNames: 'open_collection' }),
      file('test/empty.test.ts'),
      file('test/loop.test.ts', { inexactNames: 'open_collection' }),
      file('test/dynamic.test.ts', { unseenReach: true }),
    ]);

    expect(unread).toEqual([
      'test/loop.test.ts (it runs code while its tests are collected that may register tests)',
      'test/dynamic.test.ts (it reaches code static analysis does not follow)',
    ]);
  });

  it('leaves out only helpers shown not to use the runner', () => {
    const unread = unreadOf([
      // `export { test } from 'node:test'`, or a helper with no runner call at all.
      file('test/support.ts', { inexactNames: 'open_collection', usesRunner: false, loadsCode: false }),
      // Reaching code static analysis does not follow, it is not shown not to use the runner.
      file('test/fixtures.ts', { unseenReach: true, usesRunner: true }),
      file('test/shared.test.ts', { inexactNames: 'imported_registrations', usesRunner: false }),
      // It calls the runner in a way static analysis cannot read (`test[key](...)`).
      file('test/computed.test.ts', { inexactNames: 'open_collection', usesRunner: true }),
    ]);

    expect(unread).toEqual([
      'test/fixtures.ts (it reaches code static analysis does not follow)',
      'test/shared.test.ts (a module it imports registers its tests)',
      'test/computed.test.ts (it runs code while its tests are collected that may register tests)',
    ]);
  });

  it('keeps listing a test file that loads the runner with a dynamic import', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'veritas-unread-'));
    mkdirSync(path.join(root, 'test'));
    writeFileSync(
      path.join(root, 'test/dynamic.test.mjs'),
      "const nt = await import('node:test');\nnt.test('x', () => {});\n",
    );
    writeFileSync(path.join(root, 'test/support.mjs'), "export { test } from 'node:test';\n");
    const inventory = inventoryTests({
      recognition: nodeTestRunner.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['test/**/*.mjs'] },
      }),
    });

    expect(inventory.tests).toEqual([]);
    expect(unreadTestFiles(inventory)).toEqual([expect.stringMatching(/^test\/dynamic\.test\.mjs \(/)]);
  });

  it('leaves out a zero-test file only when neither it nor what it loads runs code when loading', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'veritas-unread-'));
    const files: Record<string, string> = {
      // The review's repro: the package call hidden in a local function.
      'test/register.test.mjs':
        "import { suite } from 'shared-tests';\nfunction register() { suite(); }\nregister();\n",
      'test/local-call.test.mjs': 'function setup() {}\nsetup();\n',
      'test/iife.test.mjs': '(() => {})();\n',
      'test/through-helper.test.mjs': "import './helpers/boot.mjs';\n",
      'test/helpers/boot.mjs': 'export const app = createApp();\nfunction createApp() { return {}; }\n',
      'test/package.test.mjs': "import { z } from 'zod';\nexport const schema = z;\n",
      // Shown to register nothing.
      'test/barrel.test.mjs': "export { test } from 'node:test';\nexport * from './helpers/pure.mjs';\n",
      'test/helpers/pure.mjs':
        "import path from 'node:path';\nexport const dir = path.join('a', 'b');\nexport const key = Symbol('k');\nexport const frozen = Object.freeze({ a: 1 });\nexport function later() { return later2(); }\nfunction later2() {}\n",
      'test/defines.test.mjs':
        "import { suite } from './helpers/pure.mjs';\nexport function later() { suite(); }\n",
    };

    for (const [relative, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), content);
    }
    const inventory = inventoryTests({
      recognition: nodeTestRunner.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['test/*.test.mjs'] },
      }),
    });

    expect(unreadTestFiles(inventory).sort()).toEqual([
      'test/iife.test.mjs (it runs code while its tests are collected that may register tests)',
      // Static analysis took this one for closed: only the new rule lists it.
      'test/local-call.test.mjs (it runs code when it loads and may register tests)',
      'test/package.test.mjs (it runs code when it loads and may register tests)',
      'test/register.test.mjs (it runs code while its tests are collected that may register tests)',
      'test/through-helper.test.mjs (it runs code while its tests are collected that may register tests)',
    ]);
  });

  it('gives a generic reason for a file that only runs code when it loads', () => {
    expect(unreadOf([file('test/a.test.mjs', { usesRunner: false, loadsCode: true })])).toEqual([
      'test/a.test.mjs (it runs code when it loads and may register tests)',
    ]);
    expect(unreadOf([file('test/b.test.mjs', { usesRunner: false, loadsCode: false })])).toEqual([]);
  });

  it("says a file uses another runner's API instead of that it may register tests", () => {
    const unread = unreadOf([
      file('test/bun.test.ts', {
        inexactNames: 'open_collection',
        usesRunner: false,
        foreignRunner: 'bun:test',
      }),
      file('test/deno.test.ts', { usesRunner: false, foreignRunner: 'Deno.test' }),
    ]);

    expect(unread).toEqual([
      "test/bun.test.ts (it uses bun:test, the API of a test runner the project's test runner does not run)",
      "test/deno.test.ts (it uses Deno.test, the API of a test runner the project's test runner does not run)",
    ]);
  });

  it('names a file that calls into a package when it loads, even when it does not use the runner', () => {
    const unread = unreadOf([
      file('test/suite.test.ts', {
        inexactNames: 'open_collection',
        usesRunner: false,
        packageCall: 'some-lib',
        loadsCode: true,
      }),
      // A barrel or helper calling nothing at its top level stays out.
      file('test/barrel.test.ts', { inexactNames: 'open_collection', usesRunner: false, loadsCode: false }),
    ]);

    expect(unread).toEqual([
      'test/suite.test.ts (it calls into package some-lib when it loads and may register tests through it)',
    ]);
  });

  it('names the local module through which a file calls into a package', () => {
    const unread = unreadTestFiles({
      tests: [],
      edges: [],
      files: [
        {
          ...file('test/a.test.mjs', { usesRunner: false, packageCall: 'shared-tests', loadsCode: true }),
          packageCallVia: 'test/helper.mjs',
        },
      ],
      diagnostics: [],
    });

    expect(unread).toEqual([
      'test/a.test.mjs (it loads test/helper.mjs, which calls into package shared-tests when it loads and may register tests through it)',
    ]);
  });

  it('lists the first ten files in a message and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, index) => `f${index}`);

    expect(listUnreadTestFiles(many)).toBe(`${many.slice(0, 10).join('; ')}; and 3 more`);
    expect(listUnreadTestFiles(many.slice(0, 10))).toBe(many.slice(0, 10).join('; '));
  });
});
