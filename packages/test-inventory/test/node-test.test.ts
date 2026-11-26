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
    config: VeritasConfig.parse({ analysis: { testFramework: 'node_test' } }),
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
        test('constant only', async (t) => {
          await t.test('child', () => {
            t.assert.ok(true);
          });
        });
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => test.name)).toEqual(['parent', 'constant only']);
    expect(byName(tests, 'parent')).toMatchObject({
      assertionCount: 1,
      calledSymbols: ['src/value.ts#value'],
      suspicions: [],
    });
    expect(byName(tests, 'constant only').suspicions).toContain('tautological_assertion');
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
