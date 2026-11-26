import { VeritasConfig } from '@under18dev/veritas-core';
import { nodeTestRunner as node } from '@under18dev/veritas-test-runner-node';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

const inventory = (root: string) =>
  inventoryTests({
    recognition: node.recognitionFor(root),
    root,
    config: VeritasConfig.parse({
      analysis: { testFramework: 'node_test', testInclude: ['**/*.test.{ts,js,mjs,cjs}'] },
    }),
  });

type Tests = ReturnType<typeof inventory>['tests'];

function byName(tests: Tests, name: string) {
  const test = tests.find((candidate) => candidate.name === name);

  if (!test) throw new Error(`missing test: ${name}`);

  return test;
}

const VALUE = 'export const value = (input: number) => input + 1;\n';

describe('node:test bindings', () => {
  it('registers nothing through the default of a required module, which CommonJS does not have', () => {
    const root = tempProject({
      'test/required.test.cjs': `
        const assert = require('node:assert/strict');
        const viaMember = require('node:test').default;
        const viaBracket = require('node:test')['default'];
        const { default: destructured } = require('node:test');
        const nt = require('node:test');
        const { test } = require('node:test');
        viaMember('member default', () => assert.equal(1, 1));
        viaBracket('bracket default', () => assert.equal(1, 1));
        destructured('destructured default', () => assert.equal(1, 1));
        nt.default('module default', () => assert.equal(1, 1));
        test('plain', () => assert.equal(1, 1));
      `,
      'test/imported.test.mjs': `
        import { default as check } from 'node:test';
        import * as NT from 'node:test';
        import assert from 'node:assert/strict';
        check('import default', () => assert.equal(1, 1));
        NT.default('namespace default', () => assert.equal(1, 1));
      `,
    });

    expect(inventory(root).tests.map((test) => test.name)).toEqual([
      'import default',
      'namespace default',
      'plain',
    ]);
  });

  it('reads modifiers on a required member, in brackets and deeper, and nothing else deeper', () => {
    const root = tempProject({
      'test/deep.test.cjs': `
        const assert = require('node:assert/strict');
        const skippedSuite = require('node:test')['describe']['skip'];
        const focused = require('node:test').it.only;
        const todo = require('node:test')['test'].todo;
        const { test } = require('node:test');
        skippedSuite('skipped suite', () => {
          test('inside', () => assert.equal(1, 1));
        });
        focused('focused', () => assert.equal(1, 1));
        todo('later', () => assert.equal(1, 1));
        test['skip']('bracket skip', () => assert.equal(1, 1));
        test['only']('bracket only', () => assert.equal(1, 1));
        test('plain', () => assert.equal(1, 1));
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => [test.name, test.suitePath, test.modifiers])).toEqual([
      ['inside', ['skipped suite'], ['skip']],
      ['focused', [], ['only']],
      ['later', [], ['todo']],
      ['bracket skip', [], ['skip']],
      ['bracket only', [], ['only']],
      ['plain', [], []],
    ]);
  });

  it('takes a file that loads code at run time for one that may use the runner', () => {
    const root = tempProject({
      // The repro of the review: the runner loaded by a dynamic import.
      'test/dynamic.test.mjs': "const nt = await import('node:test');\nnt.test('x', () => {});\n",
      'test/then.test.mjs': "import('node:test').then((nt) => nt.test('x', () => {}));\n",
      'test/computed.test.mjs': "const name = 'node:' + 'test';\nawait import(name);\n",
      'test/local.test.mjs': "await import('./suite.mjs');\n",
      'test/created.test.mjs':
        "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('node:test').test('x', () => {});\n",
      'test/required.test.cjs': "const name = 'node:test';\nrequire(name).test('x', () => {});\n",
      'test/builtin.test.mjs': "process.getBuiltinModule('node:test').test('x', () => {});\n",
      'test/evaluated.test.mjs': 'eval("import(\'node:test\')");\n',
      'test/global.test.mjs': "const key = 'x';\nglobalThis[key]();\n",
      'test/aliased.test.cjs': "const require2 = require;\nrequire2('node:test').test('x', () => {});\n",
      'test/module-require.test.cjs': "module.require('node:test').test('x', () => {});\n",
      'test/named-created.test.mjs':
        "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nload('node:test').test('x', () => {});\n",
      // Shown not to: a Node.js builtin loaded at run time is not the runner.
      'test/plain-builtin.test.mjs': "const { join } = await import('node:path');\njoin('a');\n",
      'test/suite.mjs': 'export {};\n',
    });
    const result = inventoryTests({
      recognition: node.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['test/**/*.test.{mjs,cjs}'] },
      }),
    });
    const uses = Object.fromEntries(result.files.map((file) => [file.path, file.usesRunner]));

    expect(uses).toEqual({
      'test/aliased.test.cjs': true,
      'test/module-require.test.cjs': true,
      'test/named-created.test.mjs': true,
      'test/builtin.test.mjs': true,
      'test/computed.test.mjs': true,
      'test/created.test.mjs': true,
      'test/dynamic.test.mjs': true,
      'test/evaluated.test.mjs': true,
      'test/global.test.mjs': true,
      // A local module imported on demand is followed: this one uses nothing.
      'test/local.test.mjs': false,
      'test/plain-builtin.test.mjs': false,
      'test/required.test.cjs': true,
      'test/then.test.mjs': true,
    });
    expect(result.tests).toEqual([]);
  });

  it('records a package a test file calls into at its top level, and none for barrels and helpers', () => {
    const root = tempProject({
      'test/suite.test.ts': "import { suite } from 'some-lib';\nsuite();\n",
      'test/awaited.test.mjs': "import * as lib from '@scope/shared/run';\nawait lib.default.register();\n",
      'test/declared.test.cjs': "const { make } = require('other-lib');\nconst tests = make();\n",
      'test/chained.test.ts': "import { builder } from 'chain-lib';\nbuilder().run();\n",
      // Inside collection-time control flow.
      'test/if.test.ts': "import { suite } from 'shared-tests';\nif (true) suite();\n",
      'test/and.test.ts': "import { suite } from 'shared-tests';\ntrue && suite();\n",
      'test/iife.test.ts': "import { suite } from 'shared-tests';\n(() => { suite(); })();\n",
      'test/loop.test.ts': "import { suite } from 'shared-tests';\nfor (const n of [1, 2]) suite(n);\n",
      'test/try.test.ts': "import { suite } from 'shared-tests';\ntry { suite(); } catch {}\n",
      'test/static.test.ts':
        "import { suite } from 'shared-tests';\nclass Holder { static { suite(); } }\nvoid Holder;\n",
      'test/argument.test.ts':
        "import { suite } from 'shared-tests';\nconsole.log(String(suite()), [suite()].length);\n",
      // Not calls into a package that may register tests.
      'test/barrel.test.ts': "export { suite } from 'some-lib';\nexport * from 'other-lib';\n",
      'test/defined.test.ts':
        "import { suite } from 'some-lib';\nexport function later() { suite(); }\nconst run = () => suite();\nexport { run };\nclass Later { method() { suite(); } }\nexport { Later };\n",
      'test/assertions.test.ts':
        "import chai from 'chai';\nimport { setupServer } from 'msw/node';\nchai.should();\nsetupServer();\n",
      'test/builtin.test.ts':
        "import { setTimeout } from 'node:timers/promises';\nimport path from 'path';\nawait setTimeout(1);\npath.join('a');\n",
      'test/local.test.ts': "import { helper } from './helper.ts';\nhelper();\n",
      'test/helper.ts': 'export function helper() {}\n',
    });
    const result = inventoryTests({
      recognition: node.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['test/**/*.test.{ts,mjs,cjs}'] },
      }),
    });
    const called = Object.fromEntries(result.files.map((file) => [file.path, file.packageCall]));

    expect(called).toEqual({
      'test/assertions.test.ts': undefined,
      'test/and.test.ts': 'shared-tests',
      'test/argument.test.ts': 'shared-tests',
      'test/if.test.ts': 'shared-tests',
      'test/iife.test.ts': 'shared-tests',
      'test/loop.test.ts': 'shared-tests',
      'test/static.test.ts': 'shared-tests',
      'test/try.test.ts': 'shared-tests',
      'test/awaited.test.mjs': '@scope/shared',
      'test/barrel.test.ts': undefined,
      'test/builtin.test.ts': undefined,
      'test/chained.test.ts': 'chain-lib',
      'test/declared.test.cjs': 'other-lib',
      'test/defined.test.ts': undefined,
      'test/local.test.ts': undefined,
      'test/suite.test.ts': 'some-lib',
    });
  });

  it('records a package a local module the test file loads calls into, naming that module', () => {
    const root = tempProject({
      'test/helper.mjs': "import { suite } from 'shared-tests';\nsuite();\n",
      'test/middle.mjs': "import './helper.mjs';\nexport const ready = true;\n",
      'test/cycle-a.mjs': "import './cycle-b.mjs';\nexport const a = 1;\n",
      'test/cycle-b.mjs': "import './cycle-a.mjs';\nimport { suite } from 'shared-tests';\nsuite();\n",
      'test/quiet-a.mjs': "import './quiet-b.mjs';\nexport const a = 1;\n",
      'test/quiet-b.mjs': "import './quiet-a.mjs';\nexport const b = 2;\n",
      'test/defines.mjs': "import { suite } from 'shared-tests';\nexport function later() { suite(); }\n",
      'test/direct.test.mjs': "import './helper.mjs';\n",
      'test/required.test.cjs': "require('./helper.mjs');\n",
      'test/dynamic.test.mjs': "await import('./helper.mjs');\n",
      'test/chain.test.mjs': "import './middle.mjs';\n",
      'test/cycle.test.mjs': "import './cycle-a.mjs';\n",
      'test/quiet-cycle.test.mjs': "import './quiet-a.mjs';\n",
      'test/defines.test.mjs': "import { later } from './defines.mjs';\nexport { later };\n",
      'test/missing.test.mjs': "import './missing.mjs';\n",
    });
    const result = inventoryTests({
      recognition: node.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['test/*.test.{mjs,cjs}'] },
      }),
    });
    const fileOf = (path: string) => result.files.find((file) => file.path === path);

    for (const path of [
      'test/direct.test.mjs',
      'test/required.test.cjs',
      'test/dynamic.test.mjs',
      'test/chain.test.mjs',
    ])
      expect(fileOf(path), path).toMatchObject({
        packageCall: 'shared-tests',
        packageCallVia: 'test/helper.mjs',
      });
    expect(fileOf('test/cycle.test.mjs')).toMatchObject({
      packageCall: 'shared-tests',
      packageCallVia: 'test/cycle-b.mjs',
    });

    for (const path of ['test/quiet-cycle.test.mjs', 'test/defines.test.mjs']) {
      expect(fileOf(path)?.packageCall, path).toBeUndefined();
      expect(fileOf(path)?.usesRunner, path).toBe(false);
    }
    // A local module that does not resolve may make any call.
    expect(fileOf('test/missing.test.mjs')).toMatchObject({ usesRunner: true });
  });

  it('records no test for a member read by a computed key, and leaves the file open', () => {
    const root = tempProject({
      'test/computed.test.cjs': `
        const assert = require('node:assert/strict');
        const key = process.env.KIND || 'test';
        const chosen = require('node:test')[key];
        const { test } = require('node:test');
        chosen('chosen', () => assert.equal(1, 1));
        test[key]('computed modifier', () => assert.equal(1, 1));
      `,
    });
    const result = inventory(root);

    expect(result.tests).toEqual([]);
    expect(result.files[0]?.inexactNames).toBe('open_collection');
    expect(result.files[0]?.usesRunner).toBe(true);
  });

  it("records which files use the runner, and which another runner's API", () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/support.ts':
        "export { test, describe } from 'node:test';\nexport const ready = Promise.resolve();\n",
      'test/fixtures.ts': "import { value } from '../src/value.ts';\nexport const one = value(0);\n",
      'test/types.ts': "import type { TestContext } from 'node:test';\nexport type Ctx = TestContext;\n",
      'test/uses-support.test.ts': `
        import { test } from './support.ts';
        const key = 'skip';
        test[key]('computed', () => {});
      `,
      'test/bun.test.ts': "import { test, expect } from 'bun:test';\ntest('bun', () => expect(1).toBe(1));\n",
      'test/deno.test.ts': "Deno.test('deno', () => {});\n",
      'test/std.test.ts': "import { it } from 'jsr:@std/testing/bdd';\nit('std', () => {});\n",
      'test/vitest-types.test.ts':
        "import { type TestContext } from 'vitest';\nexport type { TestContext };\n",
      'test/vitest-type-export.test.ts': "export { type TestContext } from 'vitest';\n",
      'test/bun-reexport.test.ts': "export { test } from 'bun:test';\n",
      'test/plain.test.ts': "import { test } from 'node:test';\ntest('plain', () => {});\n",
      'test/shared-suite.ts':
        "import { test } from 'node:test';\nexport function registerAll() { test('elsewhere', () => {}); }\n",
      'test/registered.test.ts': "import { registerAll } from './shared-suite.ts';\nregisterAll();\n",
    });
    const result = inventoryTests({
      recognition: node.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['test/**/*.ts'] },
      }),
    });
    const fileOf = (path: string) => result.files.find((file) => file.path === path);

    for (const path of ['test/support.ts', 'test/fixtures.ts', 'test/types.ts'])
      expect(fileOf(path), path).toMatchObject({ usesRunner: false });
    expect(fileOf('test/uses-support.test.ts')).toMatchObject({ usesRunner: true });
    // Through a local module it loads: a shared suite that registers its tests.
    expect(fileOf('test/registered.test.ts')).toMatchObject({ usesRunner: true });
    expect(fileOf('test/plain.test.ts')).toMatchObject({ usesRunner: true });
    expect(fileOf('test/plain.test.ts')?.foreignRunner).toBeUndefined();
    expect(fileOf('test/bun.test.ts')).toMatchObject({ usesRunner: false, foreignRunner: 'bun:test' });
    expect(fileOf('test/deno.test.ts')).toMatchObject({ foreignRunner: 'Deno.test' });
    expect(fileOf('test/std.test.ts')).toMatchObject({ foreignRunner: 'jsr:@std/testing/bdd' });
    // Types of another runner use no API of it; a re-export of its API does.
    expect(fileOf('test/vitest-types.test.ts')?.foreignRunner).toBeUndefined();
    expect(fileOf('test/vitest-type-export.test.ts')?.foreignRunner).toBeUndefined();
    expect(fileOf('test/bun-reexport.test.ts')).toMatchObject({ foreignRunner: 'bun:test' });
  });

  it('takes a parameter for a context only where the function runs as a test, not where it is called directly', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/helper.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function helper(t) { t.assert.equal(value(1), 2); }
        test('by reference', helper);
        test('with a plain object', () => {
          helper({ assert: { equal() {} } });
        });
      `,
      'test/passed.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function shared(t) { t.assert.equal(value(1), 2); }
        test('shared by reference', shared);
        test('handing its own context', (t) => {
          shared(t);
        });
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'by reference').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'by reference').targetCalls.some((call) => call.asserted)).toBe(true);
    // The plain object's `equal` asserts nothing.
    expect(byName(tests, 'with a plain object').suspicions).toContain('no_assertion');
    expect(byName(tests, 'with a plain object').targetCalls.some((call) => call.asserted)).toBe(false);
    // Every call hands it a context: its assertions count wherever it is followed from.
    expect(byName(tests, 'shared by reference').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'handing its own context').suspicions).not.toContain('no_assertion');
  });

  it('leaves a test that hands a real context to a helper also called with a plain object inconclusive', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/mixed.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function helper(t) { t.assert.equal(value(1), 2); }
        test('by reference', helper);
        test('real context', (t) => {
          helper(t);
        });
        test('plain object', () => {
          helper({ assert: { equal() {} } });
        });
      `,
    });
    const { tests } = inventory(root);

    // Not "no assertion": whether its call of the helper asserts is not known.
    expect(byName(tests, 'real context').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'real context').suspicions).toContain('opaque_call');
    expect(byName(tests, 'real context').targetCalls.some((call) => call.asserted)).toBe(false);
    // The plain object still asserts nothing, and the test that runs the helper itself still asserts.
    expect(byName(tests, 'plain object').suspicions).toContain('no_assertion');
    expect(byName(tests, 'plain object').suspicions).not.toContain('opaque_call');
    expect(byName(tests, 'by reference').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'by reference').suspicions).not.toContain('opaque_call');
  });

  it('leaves a test inconclusive whose callback forwards its context to a helper also reached with a plain object', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      // The review's repro.
      'test/nested.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function helper(t) { t.assert.equal(value(1), 2); }
        function outer(t) { helper(t); }
        test('helper', helper);
        test('outer', outer);
        test('plain object', () => {
          outer({ assert: { equal() {} } });
        });
      `,
      // Three levels deep, with the plain object handed in at the top.
      'test/deep.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function first(t) { t.assert.equal(value(1), 2); }
        function second(t) { first(t); }
        function third(t) { second(t); }
        test('third', third);
        test('deep plain object', () => {
          third({ assert: { equal() {} } });
        });
      `,
    });

    for (const order of [false, true]) {
      // Whatever order the files are read in.
      const files = ['test/nested.test.ts', 'test/deep.test.ts'];
      const { tests } = inventoryTests({
        recognition: node.recognitionFor(root),
        root,
        config: VeritasConfig.parse({
          analysis: { testFramework: 'node_test', testInclude: ['**/*.test.ts'] },
        }),
        files: order ? files.reverse() : files,
      });

      for (const name of ['outer', 'third']) {
        expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
        expect(byName(tests, name).suspicions, name).toContain('opaque_call');
      }
      expect(byName(tests, 'helper').suspicions).not.toContain('no_assertion');
      expect(byName(tests, 'helper').targetCalls.some((call) => call.asserted)).toBe(true);

      // A plain object never gets credit for an assertion.
      for (const name of ['plain object', 'deep plain object'])
        expect(
          byName(tests, name).targetCalls.some((call) => call.asserted),
          name,
        ).toBe(false);
    }
  });

  it('reads the context of a callback that forwards it to itself', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      // The review's repro: a recursive callback passed by name.
      'test/recursive.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function check(t, n) {
          if (n) check(t, n - 1);
          t.assert.equal(value(1), 2);
        }
        test('recursive', check);
        test('calls it with its context', (t) => check(t, 2));
      `,
      // Mutual recursion, also reached with a plain object.
      'test/mutual.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function even(t, n) { if (n) odd(t, n - 1); t.assert.equal(value(1), 2); }
        function odd(t, n) { if (n) even(t, n - 1); }
        test('mutual', even);
        test('mutual through a call', (t) => odd(t, 3));
        test('mutual plain object', () => odd({ assert: { equal() {} } }, 3));
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['recursive', 'calls it with its context']) {
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
    // Reached both ways: never no_assertion where a real context reaches it.
    expect(byName(tests, 'mutual').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'mutual through a call').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'mutual through a call').suspicions).toContain('opaque_call');
    expect(byName(tests, 'mutual plain object').targetCalls.some((call) => call.asserted)).toBe(false);
  });

  it('takes a test registered through the namespace, default or required module for a real context', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/namespace.test.ts': `
        import * as nt from 'node:test';
        import { value } from '../src/value.ts';
        function check(t) { t.assert.equal(value(1), 2); }
        nt.test('namespace caller', (t) => check(t));
      `,
      'test/default.test.ts': `
        import nodeTest from 'node:test';
        import { value } from '../src/value.ts';
        function check(t) { t.assert.equal(value(1), 2); }
        nodeTest.test('default caller', (t) => check(t));
      `,
      'test/required.test.cjs': `
        const nt = require('node:test');
        const { value } = require('../src/value.ts');
        function check(t) { t.assert.equal(value(1), 2); }
        nt.test('required caller', (t) => check(t));
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['namespace caller', 'default caller', 'required caller']) {
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
  });

  it('follows a const alias of a context, and leaves a value it cannot trace inconclusive', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/alias.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function check(t) { t.assert.equal(value(1), 2); }
        test('by reference', check);
        test('const alias', (t) => {
          const context = t;
          check(context as typeof t);
        });
      `,
      'test/untraced.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function verify(t) { t.assert.equal(value(1), 2); }
        test('let alias', (t) => {
          let context = t;
          verify(context);
        });
        test('plain object', () => verify({ assert: { equal() {} } }));
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'const alias').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'const alias').targetCalls.some((call) => call.asserted)).toBe(true);
    // Not traced: inconclusive, never no_assertion.
    expect(byName(tests, 'let alias').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'let alias').suspicions).toContain('opaque_call');
    expect(byName(tests, 'plain object').targetCalls.some((call) => call.asserted)).toBe(false);
  });

  it('takes require for the module loader only when the file does not declare its own', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/shadowed.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        function require(_name: string) { return { equal() {}, ok() {} }; }
        const assert = require('node:assert');
        test('fake assert', () => { assert.equal(value(1), 2); });
      `,
      'test/shadowed-runner.test.cjs': `
        const require = (name) => ({ test() {} });
        const { test } = require('node:test');
        test('fake runner', () => {});
      `,
      'test/real.test.cjs': `
        const { test } = require('node:test');
        const assert = require('node:assert');
        const { value } = require('../src/value.ts');
        test('real assert', () => { assert.equal(value(1), 2); });
      `,
      'test/created.test.mjs': `
        import { createRequire } from 'node:module';
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        const require = createRequire(import.meta.url);
        const assert = require('node:assert');
        test('created require', () => { assert.equal(value(1), 2); });
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => test.name).sort()).toEqual(['created require', 'fake assert', 'real assert']);
    expect(byName(tests, 'fake assert').assertionCount).toBe(0);
    expect(byName(tests, 'fake assert').suspicions).toContain('no_assertion');

    for (const name of ['real assert', 'created require']) {
      expect(byName(tests, name).assertionCount, name).toBe(1);
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
  });

  it('reads node:assert and the mock tracker required inside a test', () => {
    const SERVICE = `${VALUE}export const service = { fetch: (id: number) => id };\n`;
    const root = tempProject({
      'src/value.ts': SERVICE,
      'test/local.test.cjs': `
        const { test } = require('node:test');
        const { service, value } = require('../src/value.ts');
        test('local assert', () => {
          const a = require('node:assert');
          a.strictEqual(value(1), 2);
        });
        test('local destructured', () => {
          const { deepStrictEqual: same } = require('node:assert/strict');
          same(value(1), 2);
        });
        test('local let is not trusted', () => {
          let a = require('node:assert');
          a = { strictEqual() {} };
          a.strictEqual(value(1), 2);
        });
        test('local mock', () => {
          const { mock } = require('node:test');
          mock.method(service, 'fetch', () => 999);
          require('node:assert').equal(service.fetch(1), 999);
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['local assert', 'local destructured']) {
      expect(byName(tests, name).assertionCount, name).toBe(1);
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
    expect(byName(tests, 'local let is not trusted').assertionCount).toBe(0);
    expect(byName(tests, 'local mock').usesMocks).toBe(true);
    expect(byName(tests, 'local mock').suspicions).toContain('unconditional_mock');
  });

  it('reads node:assert required inline and through createRequire, and not through a shadowing require', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/inline.test.cjs': `
        const { test } = require('node:test');
        const { value } = require('../src/value.ts');
        test('inline member', () => { require('node:assert').equal(value(1), 2); });
        test('inline strict', () => { require('node:assert').strict.equal(value(1), 2); });
        test('inline module', () => { require('node:assert')(value(1) === 2); });
      `,
      'test/created.test.mjs': `
        import { createRequire } from 'node:module';
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        test('created in the test', () => {
          const r = createRequire(import.meta.url);
          const assert = r('node:assert');
          assert.equal(value(1), 2);
        });
        test('created inline', () => {
          createRequire(import.meta.url)('node:assert').equal(value(1), 2);
        });
      `,
      'test/shadowed.test.cjs': `
        const { test } = require('node:test');
        const { value } = require('../src/value.ts');
        test('local require', () => {
          const require = () => ({ equal() {} });
          require('node:assert').equal(value(1), 2);
        });
        test('local loader not made by createRequire', () => {
          const r = (name) => ({ equal() {} });
          const assert = r('node:assert');
          assert.equal(value(1), 2);
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of [
      'inline member',
      'inline strict',
      'inline module',
      'created in the test',
      'created inline',
    ]) {
      expect(byName(tests, name).assertionCount, name).toBe(1);
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
    }

    for (const name of ['local require', 'local loader not made by createRequire']) {
      expect(byName(tests, name).assertionCount, name).toBe(0);
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
    }
  });

  it('trusts createRequire only from node:module, and gives no credit to one from anywhere else', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/helpers/fakemod.mjs': 'export const createRequire = () => () => ({ equal() {} });\n',
      'test/fake-import.test.mjs': `
        import { test } from 'node:test';
        import { createRequire } from './helpers/fakemod.mjs';
        import { value } from '../src/value.ts';
        test('imported fake', () => {
          createRequire(import.meta.url)('node:assert').equal(value(1), 3);
        });
      `,
      'test/fake-local.test.mjs': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        test('local fake', () => {
          const createRequire = () => () => ({ equal() {} });
          const r = createRequire(import.meta.url);
          r('node:assert').equal(value(1), 3);
          createRequire(import.meta.url)('node:assert').equal(value(1), 3);
        });
      `,
      'test/real.test.mjs': `
        import { test } from 'node:test';
        import { createRequire as make } from 'node:module';
        import * as mod from 'module';
        import defaultModule from 'node:module';
        import { value } from '../src/value.ts';
        test('alias', () => { make(import.meta.url)('node:assert').equal(value(1), 2); });
        test('namespace', () => {
          const r = mod.createRequire(import.meta.url);
          r('node:assert').equal(value(1), 2);
        });
        test('default member', () => { defaultModule.createRequire(import.meta.url)('node:assert').equal(value(1), 2); });
      `,
      'test/required.test.cjs': `
        const { test } = require('node:test');
        const { value } = require('../src/value.ts');
        test('required module', () => {
          require('node:module').createRequire(__filename)('node:assert').equal(value(1), 2);
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['imported fake', 'local fake']) {
      expect(byName(tests, name).assertionCount, name).toBe(0);
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(false);
    }

    for (const name of ['alias', 'namespace', 'default member', 'required module']) {
      expect(byName(tests, name).assertionCount, name).toBe(1);
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
  });

  it('follows a literal relative dynamic import as a static one when deciding whether a file uses the runner', () => {
    const root = tempProject({
      'test/plain.mjs': 'export const one = 1;\n',
      'test/registers.mjs': "import { test } from 'node:test';\ntest('x', () => {});\n",
      'test/through.mjs': "export * from './registers.mjs';\n",
      'test/support.mjs': "export { test } from 'node:test';\n",
      'test/loads-plain.test.mjs': "await import('./plain.mjs');\n",
      'test/loads-registering.test.mjs': "await import('./registers.mjs');\n",
      'test/loads-through.test.mjs': "await import('./through.mjs');\n",
      'test/loads-support.test.mjs':
        "const { test } = await import('./support.mjs');\ntest('x', () => {});\n",
      'test/loads-missing.test.mjs': "await import('./missing.mjs');\n",
      'test/loads-package.test.mjs': "await import('some-lib');\n",
    });
    const result = inventoryTests({
      recognition: node.recognitionFor(root),
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['test/loads-*.test.mjs'] },
      }),
    });
    const uses = Object.fromEntries(result.files.map((file) => [file.path, file.usesRunner]));

    expect(uses).toEqual({
      'test/loads-missing.test.mjs': true,
      'test/loads-package.test.mjs': true,
      'test/loads-plain.test.mjs': false,
      'test/loads-registering.test.mjs': true,
      'test/loads-support.test.mjs': true,
      'test/loads-through.test.mjs': true,
    });
  });

  it('reads the arguments of .apply through a constant array, and keeps all of them otherwise', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/apply.test.ts': `
        import { test } from 'node:test';
        import { strictEqual } from 'node:assert';
        import { value } from '../src/value.ts';
        test('constant array with a message', () => {
          const args = [1, 1, String(value(1))] as const;
          strictEqual.apply(null, args as unknown as [number, number, string]);
        });
        test('constant array of the result', () => {
          const args = [value(1), 2] as const;
          strictEqual.apply(null, args as unknown as [number, number]);
        });
        test('array changed before', () => {
          const args: unknown[] = [1, 1];
          args.push(value(1));
          strictEqual.apply(null, args as [number, number]);
        });
        test('array also passed to Reflect.apply', () => {
          const args = [1, 1] as const;
          Reflect.apply(String, args, []);
          strictEqual.apply(null, args as unknown as [number, number]);
        });
        test('array also passed to another apply', () => {
          const args = [1, 1] as const;
          Math.max.apply(null, args as unknown as number[]);
          strictEqual.apply(null, args as unknown as [number, number]);
        });
      `,
    });
    const { tests } = inventory(root);
    const asserted = (name: string) => byName(tests, name).targetCalls.some((call) => call.asserted);

    // The message is left out: only 1 and 1 are compared.
    expect(byName(tests, 'constant array with a message').suspicions).toContain('tautological_assertion');
    expect(asserted('constant array with a message')).toBe(false);
    expect(asserted('constant array of the result')).toBe(true);
    // Not read: every argument counts, so the call stays an assertion.
    expect(byName(tests, 'array changed before').assertionCount).toBe(1);
    expect(byName(tests, 'array changed before').suspicions).not.toContain('no_assertion');
    // Any use but the assertion's own .apply leaves it unread, never read as the literal.
    for (const name of ['array also passed to Reflect.apply', 'array also passed to another apply'])
      expect(byName(tests, name).assertionCount, name).toBe(1);
    // Reflect.apply takes the array as `this`, which may change it: not read as constants.
    expect(byName(tests, 'array also passed to Reflect.apply').suspicions).not.toContain(
      'tautological_assertion',
    );
  });
});
