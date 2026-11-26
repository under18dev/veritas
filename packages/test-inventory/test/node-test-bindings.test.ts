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

  it('records a package a test file calls into at its top level, and none for barrels and helpers', () => {
    const root = tempProject({
      'test/suite.test.ts': "import { suite } from 'some-lib';\nsuite();\n",
      'test/awaited.test.mjs': "import * as lib from '@scope/shared/run';\nawait lib.default.register();\n",
      'test/declared.test.cjs': "const { make } = require('other-lib');\nconst tests = make();\n",
      'test/chained.test.ts': "import { builder } from 'chain-lib';\nbuilder().run();\n",
      // Not calls into a package that may register tests.
      'test/barrel.test.ts': "export { suite } from 'some-lib';\nexport * from 'other-lib';\n",
      'test/defined.test.ts':
        "import { suite } from 'some-lib';\nexport function later() { suite(); }\nconst run = () => suite();\nexport { run };\n",
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
  });
});
