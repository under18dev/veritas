import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VeritasConfig } from '@under18dev/veritas-core';
import { inventoryTests } from '@under18dev/veritas-test-inventory';
import { nodeTestRunner } from '@under18dev/veritas-test-runner-node';
import { vitestTestRunner } from '@under18dev/veritas-test-runner-vitest';
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
      // A helper with no signal of its own that runs no code when it loads.
      file('test/support.ts', { usesRunner: false, loadsCode: false }),
      // Open on its own (a real `export { test } from 'node:test'` barrel is): listed whatever `loadsCode` says.
      file('test/open.ts', { inexactNames: 'open_collection', usesRunner: false, loadsCode: false }),
      file('test/unseen.ts', { unseenReach: true, usesRunner: false, loadsCode: false }),
      // Reaching code static analysis does not follow, it is not shown not to use the runner.
      file('test/fixtures.ts', { unseenReach: true, usesRunner: true }),
      file('test/shared.test.ts', { inexactNames: 'imported_registrations', usesRunner: false }),
      // It calls the runner in a way static analysis cannot read (`test[key](...)`).
      file('test/computed.test.ts', { inexactNames: 'open_collection', usesRunner: true }),
    ]);

    expect(unread).toEqual([
      'test/open.ts (it runs code while its tests are collected that may register tests)',
      'test/unseen.ts (it reaches code static analysis does not follow)',
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
    // The barrel re-exporting the runner registers nothing and is not open on its own.
    expect(unreadTestFiles(inventory).map((line) => line.slice(0, line.indexOf(' (')))).toEqual([
      'test/dynamic.test.mjs',
    ]);
  });

  it('leaves out a zero-test file only when neither it nor what it loads is shown to run no code', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'veritas-unread-'));
    const files: Record<string, string> = {
      // The review's repro: the package call hidden in a local function.
      'test/register.test.mjs':
        "import { suite } from 'shared-tests';\nfunction register() { suite(); }\nregister();\n",
      'test/local-call.test.mjs': 'function setup() {}\nsetup();\n',
      'test/iife.test.mjs': '(() => {})();\n',
      'test/through-helper.test.mjs': "import './helpers/boot.mjs';\n",
      'test/helpers/boot.mjs': 'export const app = createApp();\nfunction createApp() { return {}; }\n',
      'test/side-effect.test.mjs': "import 'shared-tests/register';\n",
      'test/side-effect-require.test.cjs': "require('shared-tests/register');\n",
      'test/star.test.mjs': "export * from 'shared-tests';\n",
      // Code that runs without a call (each was listed before the rule only looked at calls).
      'test/await.test.mjs': "import { ready } from 'shared-tests';\nawait ready;\n",
      'test/for-of.test.mjs': 'const cases = [1, 2];\nfor (const c of cases) void c;\n',
      'test/spread.test.mjs': 'const cases = [1, 2];\nexport const all = [...cases];\n',
      'test/getter.test.mjs': 'const cfg = { get v() { return 1; } };\nexport const v = cfg.v;\n',
      'test/setter.test.mjs': 'const cfg = { set on(value) {} };\ncfg.on = true;\n',
      'test/decorator.test.ts':
        'function register(target: unknown) { return target; }\n@register\nexport class Suite {}\n',
      // A test file of the runner's own pattern whose package registers tests when it loads, through a binding alone.
      'test/named.test.mjs': "import { suite } from 'shared-tests';\nexport { suite };\n",
      'test/default.test.mjs': "import suite from 'shared-tests';\nexport { suite };\n",
      'test/reexport.test.mjs': "export { suite } from 'shared-tests';\n",
      'test/module-exports.test.cjs': "module.exports = require('shared-tests');\n",
      'test/named-lodash.test.mjs':
        "import { pick } from 'lodash';\nexport const select = (o) => pick(o, 'a');\n",
      // Shown to register nothing.
      'test/barrel.test.mjs': "export { test } from 'node:test';\nexport * from './helpers/pure.mjs';\n",
      'test/types.test.ts':
        "import type { Thing } from 'shared-tests';\nexport type Alias = Thing;\nexport interface Shape { a: number }\n",
      'test/constants.test.mjs':
        "export const LIMIT = 10;\nexport const NAMES = ['a', 'b'];\nexport const CONFIG = { retries: 2, tags: ['x'] };\n",
      'test/setup.test.ts':
        "import { before, afterEach, mock } from 'node:test';\nbefore(() => {});\nafterEach(() => mock.restoreAll());\nmock.timers.enable();\n",
      'test/helpers/pure.mjs':
        "import path from 'node:path';\nexport const dir = path.join('a', 'b');\nexport const key = Symbol('k');\nexport const frozen = Object.freeze({ a: 1 });\nexport function later() { return later2(); }\nfunction later2() {}\n",
      'test/defines.test.mjs':
        "import { later } from './helpers/pure.mjs';\nexport function run() { later(); }\n",
      // Local JSON data runs no code when it loads.
      'test/helpers/data.json': '{ "n": 1 }\n',
      'test/json.test.mjs':
        "import data from './helpers/data.json' with { type: 'json' };\nexport { data };\n",
      // The review's repro: destructuring an object literal runs its getter.
      'test/getter-destructure.test.mjs':
        "const { x } = { get x() { return require('node:test')['te' + 'st']('hidden', () => {}); } };\nexport { x };\n",
      'test/json-assert.test.mjs':
        "import data from './helpers/data.json' assert { type: 'json' };\nexport { data };\n",
      'test/json-require.test.cjs':
        "const data = require('./helpers/data.json');\nmodule.exports = { data };\n",
      'test/json-dynamic.test.mjs':
        "export const loading = import('./helpers/data.json', { with: { type: 'json' } });\n",
      // CommonJS exports of inert values.
      'test/cjs-exports.test.cjs':
        "module.exports = { limit: 1 };\nmodule.exports.names = ['a'];\nexports.drop = function drop(o) { return o; };\n",
      // A strict-pattern test file binding a package by require: may register through it.
      'test/required-lodash.test.cjs':
        "const { omit } = require('lodash');\nmodule.exports.drop = function drop(o) { return omit(o, 'x'); };\n",
      // Genuinely open: a dynamic import of a computed name, a computed member of the runner.
      'test/open-dynamic.test.mjs': "const name = './x.mjs';\nexport const loading = import(name);\n",
      'test/open-computed.test.cjs':
        "const key = 'te' + 'st';\nconst register = require('node:test')[key];\nmodule.exports = { register };\n",
      // A helper matched only by the directory glob: a package imported by name and used inside functions.
      'test/helpers/lodash.mjs':
        "import { pick } from 'lodash';\nexport function select(o) { return pick(o, 'a'); }\n",
      'test/helpers/lodash-require.cjs':
        "const { omit } = require('lodash');\nmodule.exports.drop = function drop(o) { return omit(o, 'x'); };\n",
    };

    for (const [relative, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), content);
    }
    const inventory = inventoryTests({
      recognition: nodeTestRunner.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: {
          testFramework: 'node_test',
          testInclude: ['test/*.test.{mjs,cjs,ts}', 'test/helpers/lodash*.{mjs,cjs}'],
        },
      }),
    });
    // The getter itself makes the object literal run code, not only the guard.
    expect(inventory.files.find((file) => file.path === 'test/getter-destructure.test.mjs')?.loadsCode).toBe(
      true,
    );
    const listed = unreadTestFiles(inventory).map((line) => line.slice(0, line.indexOf(' (')));

    expect(listed.sort()).toEqual([
      'test/await.test.mjs',
      'test/decorator.test.ts',
      'test/default.test.mjs',
      'test/for-of.test.mjs',
      'test/getter-destructure.test.mjs',
      'test/getter.test.mjs',
      'test/iife.test.mjs',
      'test/local-call.test.mjs',
      'test/module-exports.test.cjs',
      'test/named-lodash.test.mjs',
      'test/named.test.mjs',
      'test/open-computed.test.cjs',
      'test/open-dynamic.test.mjs',
      'test/reexport.test.mjs',
      'test/register.test.mjs',
      'test/required-lodash.test.cjs',
      'test/setter.test.mjs',
      'test/side-effect-require.test.cjs',
      'test/side-effect.test.mjs',
      'test/spread.test.mjs',
      'test/star.test.mjs',
      'test/through-helper.test.mjs',
    ]);
  });

  it("takes the runner's hooks and mock configuration for code that registers no test", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'veritas-unread-'));
    mkdirSync(path.join(root, 'test'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src/api.ts'), 'export const get = () => 1;\n');
    writeFileSync(
      path.join(root, 'test/setup.test.ts'),
      "import { beforeAll, afterEach, vi } from 'vitest';\nvi.mock('../src/api', () => ({ get: vi.fn() }));\nbeforeAll(() => {});\nafterEach(() => vi.restoreAllMocks());\n",
    );
    writeFileSync(
      path.join(root, 'test/hoisted.test.ts'),
      "import { vi } from 'vitest';\nconst h = vi.hoisted(() => ({ n: 1 }));\nexport { h };\n",
    );
    writeFileSync(path.join(root, 'test/barrel.test.ts'), "export * from 'vitest';\n");
    writeFileSync(
      path.join(root, 'test/users.test.ts'),
      'const users = makeUsers(3);\nfunction makeUsers(n: number) { return n; }\nexport { users };\n',
    );
    const inventory = inventoryTests({
      recognition: vitestTestRunner.recognitionFor(root),
      root,
      config: VeritasConfig.parse({ analysis: { testInclude: ['test/*.test.ts'] } }),
    });
    const listed = unreadTestFiles(inventory).map((line) => line.slice(0, line.indexOf(' (')));

    // `vi.hoisted` runs its function right away; `makeUsers(3)` is a call like any other.
    expect(listed.sort()).toEqual(['test/hoisted.test.ts', 'test/users.test.ts']);
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
      file('test/barrel.test.ts', { usesRunner: false, loadsCode: false }),
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
