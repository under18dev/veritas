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
        test('not skipped', { skip: false, todo: '' }, () => assert.equal(value(1), 2));
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
