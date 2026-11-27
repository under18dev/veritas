import { VeritasConfig } from '@under18dev/veritas-core';
import { jestTestRunner as jest } from '@under18dev/veritas-test-runner-jest';
import { nodeTestRunner as node } from '@under18dev/veritas-test-runner-node';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

const SERVICE = `export const svc = { price: (n: number) => n + 1 };\nexport const value = (n: number) => n + 1;\nexport const two = 2;\n`;

const inventory = (root: string, recognition: Parameters<typeof inventoryTests>[0]['recognition']) =>
  inventoryTests({
    recognition,
    root,
    config: VeritasConfig.parse({ analysis: { testInclude: ['test/*.test.ts'] } }),
  });

function byName(tests: ReturnType<typeof inventory>['tests'], name: string) {
  const test = tests.find((candidate) => candidate.name === name);

  if (!test) throw new Error(`missing test: ${name}`);

  return test;
}

describe('test contexts and ordinary helpers', () => {
  const helperCases = (header: string, assertion: string) => `
    ${header}
    import { svc, two } from '../src/svc';
    function check(x: number) { ${assertion} }
    test('call result', () => { check(svc.price(1)); });
    test('imported value', () => { check(two); });
    test('let variable', () => {
      let n = svc.price(1);
      n += 0;
      check(n);
    });
  `;

  for (const [runner, recognition, header, assertion] of [
    ['Vitest', vitest.recognition, "import { expect, test } from 'vitest';", 'expect(x).toBe(2);'],
    ['Jest', jest.recognition, '', 'expect(x).toBe(2);'],
    [
      'node:test',
      node.recognition,
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';",
      'assert.equal(x, 2);',
    ],
  ] as const)
    it(`judges an ordinary assertion helper as before, never opaque (${runner})`, () => {
      const root = tempProject({
        'src/svc.ts': SERVICE,
        'test/helper.test.ts': helperCases(header, assertion),
      });
      const { tests } = inventory(root, recognition);

      for (const name of ['call result', 'imported value', 'let variable']) {
        expect(byName(tests, name).suspicions, `${runner} ${name}`).not.toContain('opaque_call');
        expect(byName(tests, name).suspicions, `${runner} ${name}`).not.toContain('no_assertion');
      }
    });

  it('judges a helper handed node:assert or an error, not a context, as asserting nothing', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/n28a.test.ts': `
        import { test } from 'node:test';
        import assert, { AssertionError } from 'node:assert';
        import { value } from '../src/svc';
        function helper(a) { a.equal(value(1), 2); }
        test('handed assert', () => { helper(assert); });
        test('handed an error', () => { helper(new AssertionError({ message: 'x' })); });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['handed assert', 'handed an error']) {
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
      expect(byName(tests, name).suspicions, name).not.toContain('opaque_call');
    }
  });

  it('keeps a test that hands its context to a helper using it in ways not followed inconclusive', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/c1.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        const runner = { run(t) { t.assert.equal(value(1), 2); } };
        function destr({ assert }) { assert.equal(value(1), 2); }
        function viaMethod(t) { runner.run(t); }
        function stored(t) { const s = { t }; s.t.assert.equal(value(1), 2); }
        function args0() { arguments[0].assert.equal(value(1), 2); }
        function rest(...all) { all[0].assert.equal(value(1), 2); }
        test('destr caller', (t) => destr(t));
        test('viaMethod caller', (t) => viaMethod(t));
        test('stored caller', (t) => stored(t));
        test('args0 caller', (t) => args0(t));
        test('rest caller', (t) => rest(t));
        test('destr by reference', destr);
        test('viaMethod by reference', viaMethod);
        test('stored by reference', stored);
        test('args0 by reference', args0);
        test('rest by reference', rest);
      `,
    });
    const { tests } = inventory(root, node.recognition);

    // The destructured member is read as the context's: the assertion counts.
    expect(byName(tests, 'destr by reference').assertionCount).toBe(1);

    for (const name of ['destr caller', 'destr by reference']) {
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }

    for (const name of [
      'viaMethod caller',
      'stored caller',
      'args0 caller',
      'rest caller',
      'viaMethod by reference',
      'stored by reference',
      'args0 by reference',
      'rest by reference',
    ]) {
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(byName(tests, name).suspicions, name).toContain('opaque_call');
    }
  });

  it("keeps Vitest's destructured expect working in a callback passed by name", () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/ctx.test.ts': `
        import { test } from 'vitest';
        import { value } from '../src/svc';
        function check({ expect }) { expect(value(1)).toBe(2); }
        test('by reference', check);
        test('inline', ({ expect }) => { expect(value(1)).toBe(2); });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    for (const name of ['by reference', 'inline']) {
      expect(byName(tests, name).suspicions, name).not.toContain('opaque_call');
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
    }
  });
});
