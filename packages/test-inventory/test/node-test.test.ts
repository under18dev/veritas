import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VeritasConfig } from '@under18dev/veritas-core';
import { nodeTestRunner as node } from '@under18dev/veritas-test-runner-node';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests, testId } from '../src/index.js';
import { tempProject } from './helpers.js';

const inventory = (root: string, recognition = node.recognitionFor(root)) =>
  inventoryTests({
    recognition,
    root,
    config: VeritasConfig.parse({
      analysis: { testFramework: 'node_test', testInclude: ['**/*.test.{ts,tsx,js,mjs,cjs,mts,cts}'] },
    }),
  });

function byName(tests: ReturnType<typeof inventory>['tests'], name: string) {
  const test = tests.find((candidate) => candidate.name === name);

  if (!test) throw new Error(`missing test: ${name}`);

  return test;
}

const VALUE = 'export const value = (input: number) => input + 1;\n';

describe('Node.js test runner tests', () => {
  it('recognises test, it, describe and suite from node:test, the default import and aliases too', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/api.test.ts': `
        import check, { describe, it, suite, test as nodeTest } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        describe('value', () => {
          it('adds one', () => {
            assert.equal(value(1), 2);
          });
          suite('inner', () => {
            nodeTest('adds one to zero', () => assert.equal(value(0), 1));
          });
        });
        check('through the default import', () => {
          assert.strictEqual(value(2), 3);
        });
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => test.name)).toEqual([
      'adds one',
      'adds one to zero',
      'through the default import',
    ]);
    expect(byName(tests, 'adds one')).toMatchObject({
      suitePath: ['value'],
      assertionCount: 1,
      calledSymbols: ['src/value.ts#value'],
      suspicions: [],
    });
    expect(byName(tests, 'adds one to zero').suitePath).toEqual(['value', 'inner']);
    expect(byName(tests, 'adds one').id).toBe(testId('test/api.test.ts', ['value'], 'adds one'));
    expect(byName(tests, 'through the default import').targetCalls[0]?.asserted).toBe(true);
  });

  it('counts every form of node:assert: the function, its methods, named imports, strict and require', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/asserts.test.ts': `
        import { test } from 'node:test';
        import assert, { strict } from 'node:assert';
        import { deepStrictEqual, equal as same, throws } from 'node:assert/strict';
        import * as nodeAssert from 'assert';
        import { value } from '../src/value.ts';
        test('called', () => assert(value(1) === 2));
        test('method', () => assert.notStrictEqual(value(1), 3));
        test('named', () => same(value(1), 2));
        test('deep', () => deepStrictEqual([value(1)], [2]));
        test('strict object', () => strict.equal(value(1), 2));
        test('nested strict', () => assert.strict.equal(value(1), 2));
        test('namespace', () => nodeAssert.ok(value(1) === 2));
        test('throws', () => throws(() => value(Number.NaN), /x/));
        test('context', (t) => t.assert.equal(value(1), 2));
      `,
      'test/required.test.cjs': `
        const { test } = require('node:test');
        const assert = require('node:assert').strict;
        test('required', () => assert.equal(1 + 1, 2));
      `,
    });
    const { tests } = inventory(root);

    // The CommonJS file: the required API and assertions, here on no project code.
    expect(byName(tests, 'required')).toMatchObject({ file: 'test/required.test.cjs', assertionCount: 1 });
    expect(byName(tests, 'required').suspicions).toEqual(['target_not_called']);

    for (const name of [
      'called',
      'method',
      'named',
      'deep',
      'strict object',
      'nested strict',
      'namespace',
      'throws',
      'context',
    ])
      expect(byName(tests, name), name).toMatchObject({
        assertionCount: 1,
        calledSymbols: ['src/value.ts#value'],
        suspicions: [],
      });
  });

  it('reads CommonJS test files that require node:test and node:assert', () => {
    const root = tempProject({
      'test/required.test.cjs': `
        const { test, describe: group, it } = require('node:test');
        const nodeTest = require('node:test');
        const assert = require('node:assert').strict;
        const { strictEqual: eq } = require('node:assert/strict');
        const double = (n) => n * 2;
        group('doubling', () => {
          it('doubles', () => assert.equal(double(2), 4));
          test.skip('skipped', () => eq(double(1), 2));
        });
        nodeTest('through the module', () => eq(double(3), 6));
        nodeTest.describe('member suite', () => {
          nodeTest.it('member case', () => {
            const eq = (a, b) => a === b;
            eq(double(1), 2);
          });
        });
      `,
    });
    const result = inventoryTests({
      recognition: node.recognition,
      root,
      config: VeritasConfig.parse({
        analysis: { testFramework: 'node_test', testInclude: ['**/*.test.{cjs,mjs,js,ts}'] },
      }),
    });
    const { tests } = result;

    expect(tests.map((test) => [test.name, test.suitePath, test.modifiers, test.assertionCount])).toEqual([
      ['doubles', ['doubling'], [], 1],
      ['skipped', ['doubling'], ['skip'], 1],
      ['through the module', [], [], 1],
      ['member case', ['member suite'], [], 0],
    ]);
    expect(result.files.find((file) => file.path === 'test/required.test.cjs')).toMatchObject({
      unseenReach: false,
    });
    expect(result.files.find((file) => file.path === 'test/required.test.cjs')?.inexactNames).toBeUndefined();
  });

  it('keeps a chained skip, todo or only whatever the options object says, as Node does', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/forced.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test.skip('chained skip', { skip: false }, () => assert.equal(value(1), 2));
        test.todo('chained todo', { todo: false }, () => assert.equal(value(1), 2));
        test.only('chained only', { only: false }, () => assert.equal(value(1), 2));
        test('options only', { skip: false }, () => assert.equal(value(1), 2));
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'chained skip').modifiers).toEqual(['skip']);
    expect(byName(tests, 'chained todo').modifiers).toEqual(['todo']);
    expect(byName(tests, 'chained only').modifiers).toEqual(['only']);
    expect(byName(tests, 'options only').modifiers).toEqual([]);
  });

  it('reads the API through a local barrel that re-exports node:test, with the types of Node.js loaded', () => {
    const typesNode = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../node_modules/@types/node',
    );
    const root = tempProject({
      'src/value.ts': VALUE,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          allowImportingTsExtensions: true,
          noEmit: true,
          types: ['node'],
        },
      }),
      'test/support.ts': "export { describe, it, test } from 'node:test';\n",
      'test/barrel.test.ts': `
        import assert from 'node:assert/strict';
        import { describe, it } from './support.ts';
        import { value } from '../src/value.ts';
        describe('through the barrel', () => {
          it('adds one', () => assert.equal(value(1), 2));
        });
      `,
    });
    mkdirSync(path.join(root, 'node_modules/@types'), { recursive: true });
    symlinkSync(realpathSync(typesNode), path.join(root, 'node_modules/@types/node'), 'junction');
    const result = inventory(root);

    // The types of Node.js are loaded: node:test resolves to their declaration file.
    expect(result.diagnostics.map((d) => d.message).join('\n')).not.toMatch(
      /Cannot find (module|name) 'node:test'/,
    );
    expect(byName(result.tests, 'adds one')).toMatchObject({
      suitePath: ['through the barrel'],
      assertionCount: 1,
      suspicions: [],
    });
  });

  it('reads which node:assert function a required member or a strict path is, and keeps all arguments otherwise', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/members.test.cjs': `
        const { test } = require('node:test');
        const { value } = require('../src/value.ts');
        const strictEqual = require('node:assert').strictEqual;
        const equalStrict = require('node:assert/strict').equal;
        const viaStrict = require('node:assert').strict.equal;
        const deep = require('assert').deepStrictEqual;
        const { strict: { notEqual } } = require('node:assert');
        const deeper = require('node:assert').strict.equal.call;
        test('member', () => { strictEqual(2, value(1)); });
        test('strict module member', () => { equalStrict(2, value(1)); });
        test('member under strict', () => { viaStrict(2, value(1)); });
        test('bare assert member', () => { deep([2], [value(1)]); });
        test('nested pattern', () => { notEqual(3, value(1)); });
        test('unknown member', () => { deeper(null, 2, value(1)); });
        test('member message', () => { strictEqual(1, 1, String(value(1))); });
      `,
      'test/esm.test.ts': `
        import { test } from 'node:test';
        import { strict } from 'node:assert';
        import * as nodeAssert from 'node:assert';
        import { value } from '../src/value.ts';
        test('esm strict member', () => strict.equal(2, value(1)));
        test('esm strict call', () => strict(value(1) === 2));
        test('esm namespace', () => nodeAssert.strict.deepEqual([2], [value(1)]));
        test('spread before message', () => strict.equal(...[1, 1], String(value(1))));
      `,
    });
    const { tests } = inventory(root);
    const asserted = (name: string) => byName(tests, name).targetCalls.some((call) => call.asserted);

    for (const name of [
      'member',
      'strict module member',
      'member under strict',
      'bare assert member',
      'nested pattern',
      'unknown member',
      'esm strict member',
      'esm strict call',
      'esm namespace',
      'spread before message',
    ]) {
      expect(asserted(name), name).toBe(true);
      expect(byName(tests, name).suspicions, name).not.toContain('tautological_assertion');
    }
    expect(asserted('member message')).toBe(false);
    expect(byName(tests, 'member message').suspicions).toContain('tautological_assertion');
  });

  it('counts calls that run node:assert, also through .call and .apply, never one that binds it', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/bound.test.ts': `
        import { test } from 'node:test';
        import assert, { AssertionError, strictEqual } from 'node:assert/strict';
        import * as nodeAssert from 'node:assert';
        import { value } from '../src/value.ts';
        const args = [value(1), 2];
        test('bound, never called', () => {
          const check = assert.strictEqual.bind(null, value(1), 2);
          void check;
        });
        test('bound named import', () => {
          const check = strictEqual.bind(null, value(1), 2);
          void check;
        });
        test('context bind', (t) => {
          const check = t.assert.equal.bind(null, value(1), 2);
          void check;
        });
        test('error class', () => {
          new AssertionError({ message: String(value(1)) });
          const made = assert.AssertionError;
          void made;
        });
        test('call', () => {
          strictEqual.call(null, value(1), 2, 'message');
        });
        test('call with a constant and a message', () => {
          strictEqual.call(null, 1, 1, String(value(1)));
        });
        test('apply with a literal array', () => {
          assert.strictEqual.apply(null, [value(1), 2, 'message']);
        });
        test('apply with a constant array and a message', () => {
          strictEqual.apply(null, [1, 1, String(value(1))]);
        });
        test('apply with another array', () => {
          strictEqual.apply(null, args as [number, number]);
          value(1);
        });
        test('unknown member of the module', () => {
          // @ts-expect-error: an assertion a newer Node.js may add.
          assert.newAssertion(value(1), 2);
        });
        test('default member', () => {
          nodeAssert.default.equal(value(1), 2);
        });
        test('strict member', () => {
          assert.strict.equal(value(1), 2);
        });
      `,
    });
    const { tests } = inventory(root);
    const asserted = (name: string) => byName(tests, name).targetCalls.some((call) => call.asserted);

    for (const name of ['bound, never called', 'bound named import', 'context bind', 'error class']) {
      expect(byName(tests, name).assertionCount, name).toBe(0);
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
      expect(asserted(name), name).toBe(false);
    }

    for (const name of [
      'call',
      'apply with a literal array',
      'unknown member of the module',
      'default member',
      'strict member',
    ]) {
      expect(byName(tests, name), name).toMatchObject({ assertionCount: 1, suspicions: [] });
      expect(asserted(name), name).toBe(true);
    }

    // `.call` and `.apply` skip `this` and leave the message out, as a direct call does.
    for (const name of ['call with a constant and a message', 'apply with a constant array and a message']) {
      expect(asserted(name), name).toBe(false);
      expect(byName(tests, name).suspicions, name).toContain('tautological_assertion');
    }
    // An array that is not written out hides the positions: an assertion, never judged empty or tautological.
    expect(byName(tests, 'apply with another array').assertionCount).toBe(1);
    expect(byName(tests, 'apply with another array').suspicions).not.toContain('tautological_assertion');
  });

  it("counts the test context's mock assertions and members not known yet", () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/context.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        test('called', (t) => {
          const fn = t.mock.fn(value);
          fn(1);
          t.assert.called(fn);
        });
        test('call count', (t) => {
          const fn = t.mock.fn(value);
          fn(1);
          t.assert.callCount(fn, 1);
        });
        test('a newer assertion', (t) => {
          // @ts-expect-error: an assertion a newer Node.js may add.
          t.assert.future(value(1));
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['called', 'call count', 'a newer assertion']) {
      expect(byName(tests, name).assertionCount, name).toBe(1);
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(byName(tests, name).suspicions, name).not.toContain('tautological_assertion');
    }
  });

  it('reads a test function passed by name as the test body, and does not judge an unreadable one empty', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/helpers.ts':
        "import assert from 'node:assert/strict';\nimport { value } from '../src/value.ts';\nexport function imported() { assert.equal(value(1), 2); }\n",
      'test/reference.test.ts': `
        import { it, test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        import { imported } from './helpers.ts';
        function declared() { assert.equal(value(1), 2); }
        const arrowConst = () => assert.equal(value(2), 3);
        function empty() { value(1); }
        test('by declaration', declared);
        it('by constant', arrowConst);
        test(declared);
        test('asserting nothing', empty);
        test('imported', imported);
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['by declaration', 'by constant', 'declared']) {
      expect(byName(tests, name), name).toMatchObject({ assertionCount: 1, suspicions: [] });
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
    expect(byName(tests, 'asserting nothing').suspicions).toContain('no_assertion');
    // The body of an imported function is not read: the test is not empty, its link is unknown.
    expect(byName(tests, 'imported').suspicions).toEqual(['opaque_call']);
  });

  it('titles a registration without a title by the name of its function, as Node does', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/titles.test.ts': `
        import { describe, it, test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        function declared() { assert.equal(value(1), 2); }
        const arrowConst = () => assert.equal(value(1), 2);
        const namedExpression = function own() { assert.equal(value(1), 2); };
        test(function addsOne() { assert.equal(value(1), 2); });
        test(declared);
        test(arrowConst);
        test(namedExpression);
        test({ skip: true }, function optioned() { assert.equal(value(1), 2); });
        describe(function suiteName() {
          it(function inner() { assert.equal(value(1), 2); });
        });
        test(() => assert.equal(value(1), 2));
        test('', function emptyTitle() { assert.equal(value(1), 2); });
        test(undefined, function undefinedTitle() { assert.equal(value(1), 2); });
        test(1 as unknown as string, function numberTitle() { assert.equal(value(1), 2); });
        const holder = { method() { assert.equal(value(1), 2); } };
        test(holder.method);
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => [test.name, test.suitePath, test.modifiers])).toEqual([
      ['addsOne', [], []],
      ['declared', [], []],
      ['arrowConst', [], []],
      ['own', [], []],
      ['optioned', [], ['skip']],
      ['inner', ['suiteName'], []],
      ['<dynamic test>', [], []],
      ['emptyTitle', [], []],
      ['undefinedTitle', [], []],
      ['numberTitle', [], []],
      ['<dynamic test>', [], []],
    ]);
    expect(byName(tests, 'addsOne')).toMatchObject({ assertionCount: 1, suspicions: [] });
    expect(tests.filter((test) => test.name === '<dynamic test>').map((test) => test.inexactName)).toEqual([
      'dynamic_title',
      'dynamic_title',
    ]);
  });

  it('never takes the message of a node:assert call for what it checks', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/messages.test.ts': `
        import { test } from 'node:test';
        import assert, { strictEqual as eq } from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test('constant with a message', () => eq(1, 1, String(value(1))));
        test('ok with a message', () => assert.ok(true, String(value(1))));
        test('throws with a message', () => assert.throws(() => {}, \`failed for \${value(1)}\`));
        test('real with a message', () => eq(value(1), 2, 'adds one'));
        test('throws with a validator', () => assert.throws(() => value(1), /bad/, 'message'));
        test('context message', (t) => t.assert.equal(2, 2, String(value(1))));
      `,
    });
    const { tests } = inventory(root);
    const asserted = (name: string) => byName(tests, name).targetCalls.some((call) => call.asserted);

    for (const name of ['constant with a message', 'ok with a message', 'context message']) {
      expect(asserted(name), name).toBe(false);
      expect(byName(tests, name).suspicions, name).toContain('tautological_assertion');
    }
    expect(asserted('throws with a message')).toBe(false);
    expect(asserted('real with a message')).toBe(true);
    expect(byName(tests, 'real with a message').suspicions).toEqual([]);
    expect(asserted('throws with a validator')).toBe(true);
  });

  it('does not take a function of another module named like an assertion for one', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/other.test.ts': `
        import { test } from 'node:test';
        import { equal } from './local-helpers.ts';
        import { value } from '../src/value.ts';
        test('looks like an assertion', () => {
          equal(value(1), 2);
        });
      `,
      'test/local-helpers.ts': 'export const equal = (a: unknown, b: unknown) => a === b;\n',
    });

    expect(byName(inventory(root).tests, 'looks like an assertion')).toMatchObject({
      assertionCount: 0,
      suspicions: ['no_assertion'],
    });
  });

  it('credits a callback-running assertion imported under another name', () => {
    const root = tempProject({
      'src/value.ts':
        'export const value = (input: number) => { if (input < 0) throw new Error("bad"); return input; };\n',
      'test/alias.test.ts': `
        import { test } from 'node:test';
        import { throws as mustThrow } from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test('aliased throws', () => {
          mustThrow(() => value(-1), /bad/);
        });
      `,
    });
    const test = byName(inventory(root).tests, 'aliased throws');

    expect(test).toMatchObject({ assertionCount: 1, suspicions: [] });
    expect(test.targetCalls[0]?.asserted).toBe(true);
  });

  it('never takes a local function for an assertion, even one shadowing an imported assertion', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/shadow.test.ts': `
        import { test } from 'node:test';
        import { strictEqual as eq } from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test('shadowed', () => {
          const eq = (a: number, b: number) => a === b;
          eq(value(1), 2);
        });
        test('imported', () => {
          eq(value(1), 2);
        });
      `,
      'test/local.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/value.ts';
        const assert = Object.assign((x: unknown) => x, { equal: (a: unknown, b: unknown) => a === b });
        test('local assert', () => {
          assert(value(1) === 2);
          assert.equal(value(1), 2);
        });
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'shadowed')).toMatchObject({ assertionCount: 0, suspicions: ['no_assertion'] });
    expect(byName(tests, 'imported')).toMatchObject({ assertionCount: 1, suspicions: [] });
    expect(byName(tests, 'local assert')).toMatchObject({ assertionCount: 0, suspicions: ['no_assertion'] });
  });

  it('reads the API through members of the default export', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/members.test.ts': `
        import test from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test.describe('suite', () => {
          test.before(() => {});
          test.it('case', () => assert.equal(value(1), 2));
          test.it.skip('skipped case', () => assert.equal(value(1), 2));
          test.test('nested test', () => assert.equal(value(0), 1));
        });
        test('direct', () => assert.equal(value(2), 3));
        test.skip('direct skipped', () => assert.equal(value(2), 3));
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => [test.name, test.suitePath, test.modifiers])).toEqual([
      ['case', ['suite'], []],
      ['skipped case', ['suite'], ['skip']],
      ['nested test', ['suite'], []],
      ['direct', [], []],
      ['direct skipped', [], ['skip']],
    ]);
  });

  it('records .skip, .todo, .only and the same as options, a reason string included', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/modifiers.test.ts': `
        import { describe, it, test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test.skip('chained skip', () => assert.equal(value(1), 2));
        it.todo('chained todo');
        test.only('chained only', () => assert.equal(value(1), 2));
        test('skip option', { skip: true }, () => assert.equal(value(1), 2));
        test('skip reason', { skip: 'flaky on CI' }, () => assert.equal(value(1), 2));
        test('todo reason', { todo: 'later' }, () => assert.equal(value(1), 2));
        test('only option', { only: true, timeout: 100 }, () => assert.equal(value(1), 2));
        test('not skipped', { skip: false, todo: undefined, only: void 0 }, () => assert.equal(value(1), 2));
        test('empty reason', { skip: '' }, () => assert.equal(value(1), 2));
        test('zero', { skip: 0 }, () => assert.equal(value(1), 2));
        test('null', { skip: null }, () => assert.equal(value(1), 2));
        test('empty todo', { todo: '' }, () => assert.equal(value(1), 2));
        test('not node options', { fails: true, concurrent: true }, () => assert.equal(value(1), 2));
        describe.skip('skipped suite', () => {
          it('inside', () => assert.equal(value(1), 2));
        });
      `,
    });
    const { tests } = inventory(root);
    const modifiers = (name: string) => byName(tests, name).modifiers;

    expect(modifiers('chained skip')).toEqual(['skip']);
    expect(modifiers('chained todo')).toEqual(['todo']);
    expect(modifiers('chained only')).toEqual(['only']);
    expect(modifiers('skip option')).toEqual(['skip']);
    expect(modifiers('skip reason')).toEqual(['skip']);
    expect(modifiers('todo reason')).toEqual(['todo']);
    expect(modifiers('only option')).toEqual(['only']);
    expect(modifiers('not skipped')).toEqual([]);
    // Node sets an option for any value but false and undefined, as \`node --test\` shows.
    expect(modifiers('empty reason')).toEqual(['skip']);
    expect(modifiers('zero')).toEqual(['skip']);
    expect(modifiers('null')).toEqual(['skip']);
    expect(modifiers('empty todo')).toEqual(['todo']);
    expect(modifiers('not node options')).toEqual([]);
    expect(modifiers('inside')).toContain('skip');
  });

  it('analyses subtests (t.test) as part of the test that registers them', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/subtests.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test('parent', async (t) => {
          await t.test('child', () => {
            assert.equal(value(1), 2);
          });
        });
        test('own context', async (t) => {
          await t.test('child', async (child) => {
            await child.test('grandchild', (grandchild) => {
              grandchild.assert.equal(value(0), 1);
            });
          });
        });
        test('constant only', async (t) => {
          await t.test('child', () => {
            t.assert.ok(true);
          });
        });
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => test.name)).toEqual(['parent', 'own context', 'constant only']);
    // Assertions on a subtest's own context count for the test that registers it, at any depth.
    expect(byName(tests, 'own context')).toMatchObject({ assertionCount: 1, suspicions: [] });
    expect(byName(tests, 'own context').targetCalls[0]?.asserted).toBe(true);
    expect(byName(tests, 'parent')).toMatchObject({
      assertionCount: 1,
      calledSymbols: ['src/value.ts#value'],
      suspicions: [],
    });
    expect(byName(tests, 'constant only').suspicions).toContain('tautological_assertion');
  });

  it("recognises mocks made through the test context and configured through a mock's .mock", () => {
    const SERVICE = `${VALUE}export const service = { fetch: (id: number) => id, mock: { mockImplementation: (f: unknown) => f } };\n`;
    const root = tempProject({
      'src/value.ts': SERVICE,
      'test/context.test.ts': `
        import { describe, it, mock, test } from 'node:test';
        import assert from 'node:assert/strict';
        import { service } from '../src/value.ts';
        test('context method', (t) => {
          t.mock.method(service, 'fetch', () => 999);
          assert.equal(service.fetch(1), 999);
        });
        describe('suite', () => {
          it('renamed context fn', async (ctx) => {
            await ctx.test('child', (child) => {
              const spy = child.mock.method(service, 'fetch');
              spy.mock.mockImplementationOnce(() => 7);
              assert.equal(service.fetch(1), 7);
            });
          });
        });
        test('configured spy', () => {
          const spy = mock.method(service, 'fetch');
          spy.mock.mockImplementation(() => 999);
          assert.equal(service.fetch(1), 999);
        });
        test('configured in one chain', (t) => {
          t.mock.method(service, 'fetch').mock.mockImplementation(() => 999);
          assert.equal(service.fetch(1), 999);
        });
        test('unrelated .mock of a project object', () => {
          service.mock.mockImplementation(() => 1);
          assert.equal(service.fetch(1), 1);
        });
        test('plain spy', () => {
          mock.method(service, 'fetch');
          assert.equal(service.fetch(1), 1);
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of [
      'context method',
      'renamed context fn',
      'configured spy',
      'configured in one chain',
    ]) {
      expect(byName(tests, name).usesMocks, name).toBe(true);
      expect(byName(tests, name).suspicions, name).toContain('unconditional_mock');
    }
    expect(byName(tests, 'unrelated .mock of a project object')).toMatchObject({ usesMocks: false });
    expect(byName(tests, 'unrelated .mock of a project object').suspicions).not.toContain(
      'unconditional_mock',
    );
    // A spy left as it is calls the real method.
    expect(byName(tests, 'plain spy').usesMocks).toBe(true);
    expect(byName(tests, 'plain spy').suspicions).not.toContain('unconditional_mock');
  });

  it('reads a replacement passed by reference as configuring the spy, and a non-function as not', () => {
    const SERVICE = `${VALUE}export const service = { fetch: (id: number) => id };\n`;
    const root = tempProject({
      'src/value.ts': SERVICE,
      'test/replacement.test.ts': `
        import { mock, test } from 'node:test';
        import assert from 'node:assert/strict';
        import { service, value } from '../src/value.ts';
        const replacement = () => 999;
        function declared() { return 999; }
        const notAFunction = { answer: 1 };
        test('const arrow', () => {
          mock.method(service, 'fetch', replacement);
          assert.equal(service.fetch(1), 999);
        });
        test('function declaration', () => {
          mock.method(service, 'fetch', declared);
          assert.equal(service.fetch(1), 999);
        });
        test('getter with an implementation', () => {
          mock.getter(service, 'fetch', () => () => 999);
          assert.equal(service.fetch(1), 999);
        });
        test('non-function constant', () => {
          mock.method(service, 'fetch', notAFunction as never);
          assert.equal(service.fetch(1), 1);
        });
        test('options only', () => {
          mock.method(service, 'fetch', { times: 1 } as never);
          assert.equal(service.fetch(1), 1);
        });
        test('mock.fn roles', () => {
          const plain = mock.fn(replacement);
          const wrapped = mock.fn(value, replacement);
          assert.equal(plain() + wrapped(1), 1998);
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['const arrow', 'function declaration', 'getter with an implementation'])
      expect(byName(tests, name).suspicions, name).toContain('unconditional_mock');

    for (const name of ['non-function constant', 'options only']) {
      expect(byName(tests, name).usesMocks, name).toBe(true);
      expect(byName(tests, name).suspicions, name).not.toContain('unconditional_mock');
    }
    expect(byName(tests, 'mock.fn roles').usesMocks).toBe(true);
  });

  it('recognises the mock tracker required from node:test, and not a local object named mock', () => {
    const SERVICE = `${VALUE}export const service = { fetch: (id: number) => id };\n`;
    const root = tempProject({
      'src/value.ts': SERVICE,
      'test/required.test.cjs': `
        const { test, mock } = require('node:test');
        const { mock: tracker } = require('node:test');
        const nt = require('node:test');
        const member = require('node:test').mock;
        const assert = require('node:assert/strict');
        const { service } = require('../src/value.ts');
        test('destructured', () => {
          mock.method(service, 'fetch', () => 999);
          assert.equal(service.fetch(1), 999);
        });
        test('renamed', () => {
          tracker.method(service, 'fetch', () => 999);
          assert.equal(service.fetch(1), 999);
        });
        test('module member', () => {
          nt.mock.method(service, 'fetch', () => 999);
          assert.equal(service.fetch(1), 999);
        });
        test('required member', () => {
          member.method(service, 'fetch', () => 999);
          assert.equal(service.fetch(1), 999);
        });
        test('inline require', () => {
          require('node:test').mock.method(service, 'fetch', () => 999);
          assert.equal(service.fetch(1), 999);
        });
      `,
      'test/local.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { service } from '../src/value.ts';
        const mock = { method: (object: unknown, name: string, impl: unknown) => impl };
        test('local mock object', () => {
          mock.method(service, 'fetch', () => 999);
          assert.equal(service.fetch(1), 1);
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of ['destructured', 'renamed', 'module member', 'required member', 'inline require']) {
      expect(byName(tests, name).usesMocks, name).toBe(true);
      expect(byName(tests, name).suspicions, name).toContain('unconditional_mock');
    }
    expect(byName(tests, 'local mock object')).toMatchObject({ usesMocks: false });
    expect(byName(tests, 'local mock object').suspicions).not.toContain('unconditional_mock');
  });

  it('recognises the hooks and the mock API of node:test', () => {
    const root = tempProject({
      'src/value.ts': `${VALUE}export const service = { fetch: (id: number) => id };\n`,
      'test/mocks.test.ts': `
        import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
        import assert from 'node:assert/strict';
        import { service, value } from '../src/value.ts';
        before(() => {});
        beforeEach(() => {});
        afterEach(() => mock.restoreAll());
        after(() => {});
        test('created', () => {
          const callback = mock.fn(value);
          callback(1);
          assert.equal(callback.mock.callCount(), 1);
        });
        test('spied', () => {
          mock.method(service, 'fetch');
          assert.equal(service.fetch(1), 1);
        });
        test('plain', () => assert.equal(value(1), 2));
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => test.name)).toEqual(['created', 'spied', 'plain']);
    expect(byName(tests, 'created').usesMocks).toBe(true);
    expect(byName(tests, 'spied').usesMocks).toBe(true);
    expect(byName(tests, 'plain').usesMocks).toBe(false);
  });

  it('finds a test that asserts nothing or only constants', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/weak.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test('asserts nothing', () => {
          value(1);
        });
        test('asserts a constant', () => {
          assert.equal(1, 1);
        });
      `,
    });
    const { tests } = inventory(root);

    expect(byName(tests, 'asserts nothing').suspicions).toContain('no_assertion');
    expect(byName(tests, 'asserts a constant').suspicions).toContain('tautological_assertion');
  });

  it('keeps node:test files closed: importing the runner is not an unseen reach', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/closed.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test('closed', () => assert.equal(value(1), 2));
      `,
    });
    const file = inventory(root).files.find((entry) => entry.path === 'test/closed.test.ts');

    expect(file).toMatchObject({ unseenReach: false });
    expect(file?.inexactNames).toBeUndefined();
  });

  it('reads a test function passed by name with Vitest too (shared by every runner)', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/vitest.test.ts': `
        import { expect, it } from 'vitest';
        import { value } from '../src/value.ts';
        function check() { expect(value(1)).toBe(2); }
        it('by name', check);
      `,
    });

    expect(byName(inventory(root, vitest.recognition).tests, 'by name')).toMatchObject({
      assertionCount: 1,
      suspicions: [],
    });
  });

  it('keeps validators held in variables, and leaves out only messages', () => {
    const root = tempProject({
      'src/value.ts': `${VALUE}export const messageFor = (n: number) => 'bad ' + n;\n`,
      'test/validators.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { messageFor } from '../src/value.ts';
        class MyError extends Error {}
        function validate(error: unknown) { return error instanceof MyError; }
        const objectValidator = { message: messageFor(1) };
        const pattern = new RegExp(messageFor(2));
        const message = 'it should throw';
        const messageTemplate = \`it should throw \${messageFor(3)}\`;
        const fail = () => { throw new Error('x'); };
        test('object in a constant', () => assert.throws(fail, objectValidator));
        test('built in a constant', () => assert.throws(fail, pattern));
        test('class', () => assert.throws(fail, MyError));
        test('function', () => assert.throws(fail, validate));
        test('message in a constant', () => assert.throws(fail, message));
        test('template message in a constant', () => assert.throws(fail, messageTemplate));
        test('call result', () => assert.throws(fail, messageFor(4) as never));
        test('String message', () => assert.throws(fail, String(messageFor(5))));
        test('toString message', () => assert.throws(fail, messageFor(6).toString()));
        test('join message', () => assert.throws(fail, [messageFor(7)].join(', ')));
        test('JSON message', () => assert.throws(fail, JSON.stringify(messageFor(8))));
      `,
    });
    const { tests } = inventory(root);
    const asserted = (name: string) => byName(tests, name).targetCalls.some((call) => call.asserted);

    for (const name of ['object in a constant', 'built in a constant', 'call result'])
      expect(asserted(name), name).toBe(true);

    for (const name of ['class', 'function', 'message in a constant', 'template message in a constant'])
      expect(byName(tests, name).assertionCount, name).toBe(1);
    // A message built from project code is not what the assertion checks.
    for (const name of [
      'template message in a constant',
      'String message',
      'toString message',
      'join message',
      'JSON message',
    ])
      expect(asserted(name), name).toBe(false);
  });

  it('leaves the bodies of skipped or todo subtests out of the test that registers them', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/skipped.test.ts': `
        import { describe, it, test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test('skipped by option', async (t) => {
          const actual = value(1);
          await t.test('child', { skip: true }, (child) => { child.assert.equal(actual, 2); });
        });
        test('todo with an empty reason', async (t) => {
          await t.test('child', { todo: '' }, () => { assert.equal(value(1), 2); });
        });
        test('unknown options', async (t) => {
          const options = { skip: Math.random() > 1 };
          await t.test('child', options, () => { assert.equal(value(1), 2); });
        });
        test('option read from the environment', async (t) => {
          await t.test('s', { skip: process.env.CI === 'x' }, () => { assert.equal(value(1), 2); });
        });
        test('options from a function', async (t) => {
          const options = () => ({ timeout: 5 });
          await t.test('s', options(), () => { assert.equal(value(1), 2); });
        });
        test('constant options that run', async (t) => {
          const o = { timeout: 5 };
          await t.test('s', o, () => { assert.equal(value(1), 2); });
        });
        test('constant options that skip', async (t) => {
          const o = { skip: true };
          await t.test('s', o, () => { assert.equal(value(1), 2); });
        });
        test('running subtest', async (t) => {
          await t.test('child', { skip: false }, () => { assert.equal(value(1), 2); });
        });
        describe('suite', () => {
          it.skip('skipped it', () => { assert.equal(value(1), 2); });
          it('active it', () => { value(1); });
        });
      `,
    });
    const { tests } = inventory(root);

    for (const name of [
      'skipped by option',
      'todo with an empty reason',
      'unknown options',
      'option read from the environment',
      'options from a function',
      'constant options that skip',
    ]) {
      expect(byName(tests, name).assertionCount, name).toBe(0);
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(false);
    }

    // A subtest that may or may not run is credited to no one, and the test is left unjudged, never empty.
    for (const name of ['unknown options', 'option read from the environment', 'options from a function']) {
      expect(byName(tests, name).suspicions, name).toContain('opaque_call');
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(byName(tests, name).suspicions, name).not.toContain('tautological_assertion');
    }
    // Options read through a constant: known to run, or known to be skipped.
    expect(byName(tests, 'constant options that run')).toMatchObject({ assertionCount: 1, suspicions: [] });
    expect(byName(tests, 'constant options that skip').suspicions).toContain('no_assertion');
    expect(byName(tests, 'running subtest')).toMatchObject({ assertionCount: 1, suspicions: [] });
    // A skipped test lends its assertions to no other.
    expect(byName(tests, 'active it')).toMatchObject({ assertionCount: 0 });
    expect(byName(tests, 'active it').suspicions).toContain('no_assertion');
  });

  it('finds a test function passed by name before a timeout or after options, with every runner', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/vitest.test.ts': `
        import { expect, it } from 'vitest';
        import { value } from '../src/value.ts';
        const check = () => expect(value(1)).toBe(2);
        it('before a timeout', check, 1000);
        it('after options', { timeout: 1000 }, check);
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    for (const name of ['before a timeout', 'after options'])
      expect(byName(tests, name), name).toMatchObject({ assertionCount: 1, suspicions: [] });
    const node = tempProject({
      'src/value.ts': VALUE,
      'test/node.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        function check() { assert.equal(value(1), 2); }
        test('after options', { timeout: 1000 }, check);
      `,
    });

    expect(byName(inventory(node).tests, 'after options')).toMatchObject({
      assertionCount: 1,
      suspicions: [],
    });
  });

  it('does not read node:test files with the Vitest API', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/node.test.ts': `
        import check from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        check('only node', () => assert.equal(value(1), 2));
      `,
    });

    expect(inventory(root, vitest.recognition).tests).toEqual([]);
  });
});
