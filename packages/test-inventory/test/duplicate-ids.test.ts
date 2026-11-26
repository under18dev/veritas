import { VeritasConfig } from '@under18dev/veritas-core';
import { jestTestRunner as jest } from '@under18dev/veritas-test-runner-jest';
import { nodeTestRunner as node } from '@under18dev/veritas-test-runner-node';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests, testId } from '../src/index.js';
import { tempProject } from './helpers.js';

const VALUE = 'export const value = (input: number) => input + 1;\n';

const inventory = (root: string, recognition = vitest.recognition) =>
  inventoryTests({
    recognition,
    root,
    config: VeritasConfig.parse({ analysis: { testInclude: ['**/*.test.ts'] } }),
  });

describe('test ids', () => {
  it('keeps the id of a test whose file, suites and title no other test shares', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/unique.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { value } from '../src/value';
        describe('value', () => {
          it('adds one', () => expect(value(1)).toBe(2));
          it('adds one to zero', () => expect(value(0)).toBe(1));
        });
      `,
    });
    const { tests } = inventory(root);

    expect(tests.map((test) => test.id)).toEqual([
      testId('test/unique.test.ts', ['value'], 'adds one'),
      testId('test/unique.test.ts', ['value'], 'adds one to zero'),
    ]);
  });

  it('gives tests that share a title, a dynamic title or no title ids of their own, the first keeping its id', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/twice.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { value } from '../src/value';
        const title = String(Math.random());
        describe('value', () => {
          it('adds one', () => expect(value(1)).toBe(2));
          it('adds one', () => { value(1); });
          it(title, () => expect(value(2)).toBe(3));
          it(title, () => { value(2); });
          it('adds one', () => expect(value(3)).toBe(4));
        });
        it('adds one', () => expect(value(1)).toBe(2));
      `,
    });
    const { tests, edges } = inventory(root);
    const base = testId('test/twice.test.ts', ['value'], 'adds one');
    const dynamic = testId('test/twice.test.ts', ['value'], '<dynamic test>');

    expect(tests.map((test) => [test.name, test.id, test.assertionCount])).toEqual([
      ['adds one', base, 1],
      ['adds one', `${base}#2`, 0],
      ['<dynamic test>', dynamic, 1],
      ['<dynamic test>', `${dynamic}#2`, 0],
      ['adds one', `${base}#3`, 1],
      // Another suite path: no collision.
      ['adds one', testId('test/twice.test.ts', [], 'adds one'), 1],
    ]);
    expect(new Set(tests.map((test) => test.id)).size).toBe(tests.length);
    // Each registration keeps its own evidence: the one without an assertion is not merged into the other.
    expect(tests[1]?.suspicions).toContain('no_assertion');
    expect(tests[0]?.suspicions).not.toContain('no_assertion');
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(edges.length);
    expect(edges.filter((edge) => edge.testId === `${base}#2`)).toHaveLength(1);
  });

  it('tells apart Jest tests that share a title, and anonymous node:test callbacks', () => {
    const root = tempProject({
      'src/value.ts': VALUE,
      'test/jest.test.ts': `
        import { value } from '../src/value';
        test('same', () => expect(value(1)).toBe(2));
        test('same', () => expect(value(2)).toBe(3));
      `,
      'test/node.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/value.ts';
        test(() => assert.equal(value(1), 2));
        test(() => assert.equal(value(2), 3));
        test('named', () => assert.equal(value(3), 4));
      `,
    });
    const jestTests = inventory(root, jest.recognitionFor(root)).tests.filter(
      (test) => test.file === 'test/jest.test.ts',
    );
    const nodeTests = inventory(root, node.recognitionFor(root)).tests.filter(
      (test) => test.file === 'test/node.test.ts',
    );

    expect(jestTests.map((test) => test.id)).toEqual([
      testId('test/jest.test.ts', [], 'same'),
      `${testId('test/jest.test.ts', [], 'same')}#2`,
    ]);
    expect(nodeTests).toHaveLength(3);
    expect(new Set(nodeTests.map((test) => test.id)).size).toBe(3);
    expect(nodeTests[2]?.id).toBe(testId('test/node.test.ts', [], 'named'));
  });
});
