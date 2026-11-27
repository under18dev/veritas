import { VeritasConfig } from '@under18dev/veritas-core';
import { jestTestRunner as jest } from '@under18dev/veritas-test-runner-jest';
import { nodeTestRunner as node } from '@under18dev/veritas-test-runner-node';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests, setInventoryIterationLimit } from '../src/index.js';
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

  it('leaves a context handed through a variable assigned later inconclusive', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/mutable.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        function check(t) { t.assert.equal(value(1), 2); }
        test('assigned later', (t) => {
          let context;
          context = t;
          check(context);
        });
        test('let never touching a context', () => {
          let n = value(1);
          n += 0;
          check(n);
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    expect(byName(tests, 'assigned later').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'assigned later').suspicions).toContain('opaque_call');
    // An ordinary value: judged as before, not opaque.
    expect(byName(tests, 'let never touching a context').suspicions).not.toContain('opaque_call');
  });

  it('takes every write form for a reassignment, never tracing a variable written through a pattern', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/writes.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        function check(t) { t.assert.equal(value(1), 2); }
        const fake = { assert: { equal() {} } };
        test('by reference', check);
        test('shorthand destructuring', (t) => {
          let context = t;
          ({ context } = { context: fake });
          check(context);
        });
        test('array destructuring', (t) => {
          let context = t;
          [context] = [fake];
          check(context);
        });
        test('nested destructuring', (t) => {
          let context = t;
          ({ a: [context] } = { a: [fake] });
          check(context);
        });
        test('for of', (t) => {
          let context = t;
          for (context of [fake]) void 0;
          check(context);
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['shorthand destructuring', 'array destructuring', 'nested destructuring', 'for of']) {
      // Never credited as the real context's assertion: inconclusive at most.
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(false);
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
    }
  });

  it('reads the first parameter of a table-driven callback as a row, not a context', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/rows.test.ts': `
        import { describe, expect, test } from 'vitest';
        import { value } from '../src/svc';
        function checkRow(n: number) { expect(value(n)).toBe(2); }
        function checkFor([n]: [number], { expect: check }) { check(value(n)).toBe(2); }
        function suiteRows(n: number) { test('inside', () => expect(value(n)).toBe(2)); }
        test.each([[1]])('each %s', checkRow);
        test.for([[1]])('for %s', checkFor);
        describe.each([[1]])('suite %s', suiteRows);
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    for (const name of ['each %s', 'for %s', 'inside'])
      expect(byName(tests, name).suspicions, name).not.toContain('opaque_call');
  });

  it('takes a test whose own context goes where it is not followed for inconclusive', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/escapes.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        function second(n, t) { t.assert.equal(value(n), 2); }
        function first(t) { t.assert.equal(value(1), 2); }
        test('later argument', (t) => { second(1, t); });
        test('Reflect.apply', (t) => { Reflect.apply(first, null, [t]); });
        test('call with this', (t) => { first.call(t, t); });
        test('stored in an array', (t) => { const box = [t]; box[0].assert.equal(value(1), 2); });
        test('stored in an object', (t) => { const box = { t }; box.t.assert.equal(value(1), 2); });
        test('own assertion', (t) => { second(1, t); t.assert.equal(value(1), 2); });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of [
      'later argument',
      'Reflect.apply',
      'call with this',
      'stored in an array',
      'stored in an object',
    ]) {
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(byName(tests, name).suspicions, name).toContain('opaque_call');
    }
    // It asserts on its own: nothing hidden to leave inconclusive.
    expect(byName(tests, 'own assertion').suspicions).not.toContain('opaque_call');
  });

  for (const [runner, recognition, header, assertion] of [
    ['Vitest', vitest.recognition, "import { expect, test } from 'vitest';", 'expect(o.price(1)).toBe(2);'],
    ['Jest', jest.recognition, '', 'expect(o.price(1)).toBe(2);'],
    [
      'node:test',
      node.recognition,
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';",
      'assert.equal(o.price(1), 2);',
    ],
  ] as const)
    it(`never takes a project object called through a helper parameter for no project call (${runner})`, () => {
      const root = tempProject({
        'src/svc.ts': SERVICE,
        'test/obj.test.ts': `
          ${header}
          import { svc } from '../src/svc';
          function checkObj(o) { ${assertion} }
          test('through a parameter', () => { checkObj(svc); });
        `,
      });
      const { tests } = inventory(root, recognition);
      const test = byName(tests, 'through a parameter');

      expect(test.suspicions, runner).not.toContain('target_not_called');
      expect(test.suspicions, runner).toContain('opaque_call');
    });

  it('links an assertion to a project call that runs the closure writing what it reads', () => {
    const root = tempProject({
      'src/compose.ts': `
        export const compose = (middleware: [(c: object, next: () => void) => void][]) => (c: object) => {
          for (const [run] of middleware) run(c, () => {});
          return c;
        };
        export class App {
          handlers: (() => void)[] = [];
          on(handler: () => void) { this.handlers.push(handler); }
        }
      `,
      'test/compose.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { App, compose } from '../src/compose';
        const tuple = (fn: (c: object, next: () => void) => void): [typeof fn] => [fn];
        describe('Compose', () => {
          it('should compose w/ other compositions', () => {
            const called: number[] = [];
            compose([tuple((_c, next) => { called.push(1); next(); })])({});
            expect(called).toEqual([1]);
          });
          it('written by the test itself', () => {
            let called = false;
            compose([])({});
            called = true;
            expect(called).toBe(true);
          });
        });
        describe('stream', () => {
          const app = new App();
          let aborted = false;
          app.on(() => { aborted = true; });
          const request = async () => { await Promise.resolve(); };
          it('Should call onAbort', async () => {
            await request();
            expect(aborted).toBe(true);
          });
        });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    for (const name of ['should compose w/ other compositions', 'Should call onAbort']) {
      const test = byName(tests, name);

      // Linked, or inconclusive: never disconnected from the project call that runs the closure.
      expect(test.suspicions, name).not.toContain('target_not_called');
      expect(
        test.suspicions.includes('opaque_call') || test.targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
    expect(byName(tests, 'Should call onAbort').suspicions).toContain('opaque_call');
    expect(byName(tests, 'written by the test itself').suspicions).not.toContain('opaque_call');
  });

  it('never judges a test whose context goes where it is not followed as asserting nothing (safety net)', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/net.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        test('handed to an unknown function', (t) => { (globalThis as any).run(t); });
        test('destructured and handed on', ({ assert }) => { (globalThis as any).run(assert); });
        test('aliased and returned', (t) => { const c = t as unknown; return c; });
        test('cast and stored', (t) => { const box = { c: t as unknown }; void box; });
        test('spread', (t) => { const copy = { ...t }; void copy; });
        test('tautological with an escaping context', (t) => {
          (globalThis as any).run(t);
          t.assert.equal(1, 1);
        });
        test('direct member calls only', (t) => { t.diagnostic(String(value(1))); t.assert.equal(value(1), 2); });
        test('reads a member in a template', (t) => { void \`\${t.name}\`; });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of [
      'handed to an unknown function',
      'destructured and handed on',
      'aliased and returned',
      'cast and stored',
      'spread',
      'tautological with an escaping context',
    ]) {
      const test = byName(tests, name);

      expect(test.suspicions, name).not.toContain('no_assertion');
      expect(test.suspicions, name).not.toContain('tautological_assertion');
      expect(test.suspicions, name).toContain('opaque_call');
    }
    expect(byName(tests, 'direct member calls only').suspicions).not.toContain('opaque_call');
    // Nothing escapes and nothing asserts: judged as before.
    expect(byName(tests, 'reads a member in a template').suspicions).toContain('no_assertion');
  });

  it("never reads Jest's done as a context", () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/done.test.ts': `
        import { value } from '../src/svc';
        function finish(done: () => void) { done(); }
        test('hands done on', (done) => { value(1); finish(done); });
        test('by reference', finish);
      `,
    });
    const { tests } = inventory(root, jest.recognition);

    for (const name of ['hands done on', 'by reference']) {
      expect(byName(tests, name).suspicions, name).not.toContain('opaque_call');
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
    }
  });

  it('follows a destructured member of the context handed to a helper', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/member.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        function check(assert) { assert.equal(value(1), 2); }
        test('destructured member', ({ assert }) => { check(assert); });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    expect(byName(tests, 'destructured member').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'destructured member').suspicions).toContain('opaque_call');
  });

  it("reads Vitest's test.for context at its position: ctx.expect, a renamed expect and a named helper", () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/for.test.ts': `
        import { test } from 'vitest';
        import { value } from '../src/svc';
        function check(ctx) { ctx.expect(value(1)).toBe(2); }
        function forHelper([n]: [number], ctx) { ctx.expect(value(n)).toBe(2); }
        test.for([[1]])('ctx.expect %s', ([n], ctx) => { ctx.expect(value(n)).toBe(2); });
        test.for([[1]])('renamed %s', ([n], { expect: e }) => { e(value(n)).toBe(2); });
        test.for([[1]])('named %s', forHelper);
        test.for([[1]])('handed on %s', ([n], ctx) => { void n; check(ctx); });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    for (const name of ['ctx.expect %s', 'renamed %s', 'named %s']) {
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(true);
    }
    expect(byName(tests, 'handed on %s').suspicions).not.toContain('no_assertion');
  });

  it('counts only side-effect writers that can run for the test', () => {
    const root = tempProject({
      'src/app.ts': `
        export class App {
          handlers: (() => void)[] = [];
          on(handler: () => void) { this.handlers.push(handler); }
        }
      `,
      'test/scope.test.ts': `
        import { beforeEach, describe, expect, it } from 'vitest';
        import { App } from '../src/app';
        let flag = false;
        describe('other suite', () => {
          beforeEach(() => { new App().on(() => { flag = true; }); });
          it('writes in its own hook', () => { expect(flag).toBe(true); });
        });
        describe('suite', () => {
          it('another test writes', () => { new App().on(() => { flag = true; }); });
          it.skip('a skipped test writes', () => { new App().on(() => { flag = true; }); });
          it('only reads', () => { expect(flag).toBe(true); });
        });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    // Its own suite's hook writes: linked, inconclusive.
    expect(byName(tests, 'writes in its own hook').suspicions).toContain('opaque_call');
    // Only other tests and another suite's hook write: not linked.
    expect(byName(tests, 'only reads').suspicions).not.toContain('opaque_call');
  });

  it('takes a write through a cast for a reassignment', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/cast.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        function check(t) { t.assert.equal(value(1), 2); }
        const fake = { assert: { equal() {} } };
        test('by reference', check);
        test('cast write', (t) => {
          let context = t;
          (context as any) = fake;
          check(context);
        });
        test('non-null write', (t) => {
          let context: typeof t | undefined = t;
          context! = fake as never;
          check(context);
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['cast write', 'non-null write']) {
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(false);
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
    }
  });

  it('reads a context destructured with a const in the test body, and ends', { timeout: 20_000 }, () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/node.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        test('const assert', (t) => {
          const { assert } = t;
          assert.equal(value(1), 2);
        });
        test('nested', (t) => {
          const { assert: { equal } } = t;
          equal(value(1), 2);
        });
        test('destructured then handed on', (t) => {
          const { assert } = t;
          (globalThis as any).run(assert);
        });
      `,
      'test/vitest.test.ts': `
        import { test } from 'vitest';
        import { value } from '../src/svc';
        test('const expect', (ctx) => {
          const { expect } = ctx;
          expect(value(1)).toBe(2);
        });
      `,
    });
    const nodeTests = inventory(root, node.recognition).tests;
    const vitestTests = inventory(root, vitest.recognition).tests;

    for (const name of ['const assert', 'nested']) {
      expect(byName(nodeTests, name).suspicions, name).not.toContain('opaque_call');
      expect(byName(nodeTests, name).suspicions, name).not.toContain('no_assertion');
    }
    expect(byName(nodeTests, 'destructured then handed on').suspicions).toContain('opaque_call');
    expect(byName(vitestTests, 'const expect').suspicions).not.toContain('opaque_call');
    expect(byName(vitestTests, 'const expect').suspicions).not.toContain('no_assertion');
  });

  it('reads what a fixpoint stopped at its cap decides as unknown, never hanging', {
    timeout: 20_000,
  }, () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/cap.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        test('const assert', (t) => {
          const { assert } = t;
          value(1);
          assert.equal(1, 1);
        });
      `,
    });
    // Read in full: the alias is followed, and the assertion compares constants.
    expect(byName(inventory(root, node.recognition).tests, 'const assert').suspicions).toContain(
      'tautological_assertion',
    );
    const restore = setInventoryIterationLimit(0);

    try {
      const test = byName(inventory(root, node.recognition).tests, 'const assert');

      // Stopped at the cap: what the context leads to is unknown, never judged tautological or empty.
      expect(test.suspicions).toContain('opaque_call');
      expect(test.suspicions).not.toContain('tautological_assertion');
      expect(test.suspicions).not.toContain('no_assertion');
    } finally {
      restore();
    }
  });
});
