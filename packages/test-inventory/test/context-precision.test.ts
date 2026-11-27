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
    const capped = inventoryTests({
      recognition: node.recognition,
      root,
      config: VeritasConfig.parse({ analysis: { testInclude: ['test/*.test.ts'] } }),
      iterationLimit: 0,
    });
    const test = byName(capped.tests, 'const assert');

    // Stopped at the cap: what the context leads to is unknown, never judged tautological or empty.
    expect(test.suspicions).toContain('opaque_call');
    expect(test.suspicions).not.toContain('tautological_assertion');
    expect(test.suspicions).not.toContain('no_assertion');
    // The limit holds for that call only.
    expect(byName(inventory(root, node.recognition).tests, 'const assert').suspicions).toContain(
      'tautological_assertion',
    );
  });

  it('leaves out skipped subtests, and scans todo ones and those whose options cannot be read', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/sub.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        const options = (globalThis as any).options;
        test('skipped subtest', (t) => {
          value(1);
          t.test('child', { skip: true }, () => (globalThis as any).sink(t));
        });
        test('chained skip', (t) => {
          value(1);
          t.test.skip('child', () => (globalThis as any).sink(t));
        });
        test('todo subtest', (t) => {
          value(1);
          t.test.todo('child', () => (globalThis as any).sink(t));
        });
        test('options not read', (t) => {
          value(1);
          t.test('child', options, () => (globalThis as any).sink(t));
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['skipped subtest', 'chained skip']) {
      expect(byName(tests, name).suspicions, name).not.toContain('opaque_call');
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
    }

    // A todo subtest runs: what it does with the context counts.
    for (const name of ['todo subtest', 'options not read'])
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
  });

  it('takes what a todo subtest writes through project code as run, and what a skipped one writes as not', () => {
    const root = tempProject({
      'src/run.ts': 'export const run = (fn: () => void) => fn();\n',
      'test/todo.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { run } from '../src/run';
        test('todo writer', async (t) => {
          let hit = 0;
          await t.test('w', { todo: true }, () => { run(() => { hit++; }); });
          assert.equal(hit, 1);
        });
        test('skipped writer', async (t) => {
          let hit = 0;
          await t.test('w', { skip: true }, () => { run(() => { hit++; }); });
          assert.equal(hit, 1);
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    // The todo subtest's project call runs and writes what the test asserts: linked, never disconnected.
    expect(byName(tests, 'todo writer').suspicions).not.toContain('target_not_called');
    expect(
      byName(tests, 'todo writer').suspicions.includes('opaque_call') ||
        byName(tests, 'todo writer').targetCalls.some((call) => call.asserted),
    ).toBe(true);
    // The skipped one never runs.
    expect(byName(tests, 'skipped writer').suspicions).not.toContain('opaque_call');
  });

  it("applies the safety net to a running subtest's own context", () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/subctx.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        function check(s) { s.assert.equal(value(1), 2); }
        const options = { timeout: 1000 };
        test('skip false', async (t) => {
          await t.test('child', { skip: false }, (s) => { Reflect.apply(check, null, [s]); });
        });
        test('const-held options', async (t) => {
          await t.test('child', options, (s) => { Reflect.apply(check, null, [s]); });
        });
        test('skipped child', async (t) => {
          value(1);
          await t.test('child', { skip: true }, (s) => { Reflect.apply(check, null, [s]); });
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['skip false', 'const-held options']) {
      expect(byName(tests, name).suspicions, name).not.toContain('no_assertion');
      expect(byName(tests, name).suspicions, name).toContain('opaque_call');
    }
    expect(byName(tests, 'skipped child').suspicions).toContain('no_assertion');
  });

  it('takes a use past the alias depth assertion counting follows as unfollowed', () => {
    const aliases = Array.from({ length: 22 }, (_, index) => `const a${index + 1} = a${index};`).join('\n');
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/deep.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        test('deep aliases', (a0) => {
          ${aliases}
          a22.assert.equal(value(1), 2);
        });
        test('shallow aliases', (a0) => {
          const a1 = a0;
          const a2 = a1;
          a2.assert.equal(value(1), 2);
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    expect(byName(tests, 'deep aliases').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'shallow aliases').suspicions).not.toContain('no_assertion');
    expect(byName(tests, 'shallow aliases').suspicions).not.toContain('opaque_call');
  });

  for (const order of ['row first', 'normal first'] as const)
    it(`gives a function registered both with table rows and a context no credit from a row (${order})`, () => {
      const registrations =
        order === 'row first'
          ? "test.each([[{ equal() {} }]])('row %#', check);\ntest('normal', check);"
          : "test('normal', check);\ntest.each([[{ equal() {} }]])('row %#', check);";
      const root = tempProject({
        'src/svc.ts': SERVICE,
        'test/shared.test.ts': `
          import { test } from 'vitest';
          import { value } from '../src/svc';
          function check(e) { e.equal(value(1), 2); }
          ${registrations}
        `,
      });
      const { tests } = inventory(root, vitest.recognition);
      const row = byName(tests, 'row %#');
      const normal = byName(tests, 'normal');

      // A row's fake object never counts as an assertion.
      expect(row.assertionCount, order).toBe(0);
      expect(
        row.targetCalls.some((call) => call.asserted),
        order,
      ).toBe(false);
      // Which the parameter is here is not known: inconclusive, never credited from the row either.
      expect(normal.suspicions, order).toContain('opaque_call');
      expect(normal.suspicions, order).not.toContain('no_assertion');
    });

  it('takes a context named only in a type for no use of it', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/types.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        test('typeof in an annotation', (t) => {
          const copy: typeof t | undefined = undefined;
          void copy;
          value(1);
        });
        test('satisfies a type of it', (t) => {
          const options = {} satisfies Partial<typeof t>;
          void options;
          value(1);
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['typeof in an annotation', 'satisfies a type of it']) {
      expect(byName(tests, name).suspicions, name).not.toContain('opaque_call');
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
    }
  });

  it('takes builtin methods of a project primitive or builtin for no project call, and project objects for one', () => {
    const root = tempProject({
      'src/svc.ts': `${SERVICE}export const names = ['a'];\nexport const when = new Date(0);\n`,
      'test/builtins.test.ts': `
        import { expect, test } from 'vitest';
        import { names, svc, two, when } from '../src/svc';
        function asText(n) { expect(n.toString()).toBe('2'); }
        function first(list) { expect(list.at(0)).toBe('a'); }
        function year(d) { expect(d.getUTCFullYear()).toBe(1970); }
        function price(o) { expect(o.price(1)).toBe(2); }
        test('primitive', () => { asText(two); });
        test('array', () => { first(names); });
        test('date', () => { year(when); });
        test('project object', () => { price(svc); });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    expect(byName(tests, 'primitive').suspicions).not.toContain('opaque_call');

    // An object, builtin or not, may have its methods replaced (`names.at = …`): opaque.
    for (const name of ['array', 'date', 'project object'])
      expect(byName(tests, name).suspicions, name).toContain('opaque_call');
  });

  it('runs nothing under a skipped subtest at any depth, whatever todo marks sit around it', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/nesting.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        test('skip inside todo', async (t) => {
          await t.test('todo', { todo: true }, async (s) => {
            await s.test('skip', { skip: true }, () => value(1));
          });
        });
        test('todo inside skip', async (t) => {
          await t.test('skip', { skip: true }, async (s) => {
            await s.test('todo', { todo: true }, () => value(1));
          });
        });
        test('todo alone', async (t) => {
          await t.test('todo', { todo: true }, () => value(1));
        });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['skip inside todo', 'todo inside skip'])
      expect(byName(tests, name).calledSymbols, name).toEqual([]);
    // A todo subtest alone runs: its call is recorded.
    expect(byName(tests, 'todo alone').calledSymbols).toEqual(['src/svc.ts#value']);
  });

  it('credits no assertion of a helper called in a todo subtest, nor in a skipped one inside it', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/helpers.test.ts': `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from '../src/svc';
        function check() { assert.equal(value(1), 2); }
        test('helper in todo', async (t) => {
          await t.test('child', { todo: true }, () => check());
        });
        test('helper in skip inside todo', async (t) => {
          await t.test('todo', { todo: true }, async (s) => {
            await s.test('skip', { skip: true }, () => check());
          });
        });
        test('helper in the test', () => { check(); });
      `,
    });
    const { tests } = inventory(root, node.recognition);

    for (const name of ['helper in todo', 'helper in skip inside todo']) {
      expect(byName(tests, name).suspicions, name).toContain('no_assertion');
      expect(
        byName(tests, name).targetCalls.some((call) => call.asserted),
        name,
      ).toBe(false);
    }
    expect(byName(tests, 'helper in the test').suspicions).not.toContain('no_assertion');
  });

  it('counts a teardown hook writer only once an earlier test of its scope ran', () => {
    const root = tempProject({
      'src/app.ts': 'export class App { on(handler: () => void) { handler(); } }\n',
      'test/teardown.test.ts': `
        import { afterEach, beforeEach, describe, expect, it } from 'vitest';
        import { App } from '../src/app';
        let set = false;
        let torn = false;
        describe('suite', () => {
          beforeEach(() => { new App().on(() => { set = true; }); });
          afterEach(() => { new App().on(() => { torn = true; }); });
          it('teardown first', () => { expect(torn).toBe(false); });
          it('setup writes', () => { expect(set).toBe(true); });
          it('teardown after a test', () => { expect(torn).toBe(true); });
        });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    expect(byName(tests, 'setup writes').suspicions).toContain('opaque_call');
    // `afterEach` runs before a test only after an earlier one.
    expect(byName(tests, 'teardown first').suspicions).not.toContain('opaque_call');
    expect(byName(tests, 'teardown after a test').suspicions).toContain('opaque_call');
  });

  it('reads arguments only within the function and the arrows that share it', () => {
    const root = tempProject({
      'src/svc.ts': SERVICE,
      'test/arguments.test.ts': `
        import { test } from 'node:test';
        import { value } from '../src/svc';
        function nested(t) {
          function inner() { return arguments.length; }
          void inner;
          t.assert.equal(value(1), 2);
        }
        function viaArrow(t) {
          const read = () => arguments[0];
          void read;
          t.assert.equal(1, 1);
        }
        test('nested function', nested);
        test('arrow', viaArrow);
      `,
    });
    const { tests } = inventory(root, node.recognition);

    expect(byName(tests, 'nested function').suspicions).not.toContain('opaque_call');
    expect(byName(tests, 'nested function').targetCalls.some((call) => call.asserted)).toBe(true);
    // The arrow shares the function's arguments: what it reads is the context, not followed.
    expect(byName(tests, 'arrow').suspicions).toContain('opaque_call');
  });

  it('keeps a project subclass declared with a builtin type opaque', () => {
    const root = tempProject({
      'src/lazy.ts': `
        export class Lazy<T> extends Promise<T> {
          override then<A, B>(onFulfilled?: (value: T) => A | PromiseLike<A>, onRejected?: (reason: unknown) => B | PromiseLike<B>) {
            return super.then(onFulfilled, onRejected);
          }
        }
        export const lazy: Promise<number> = new Lazy<number>((resolve) => resolve(1));
        export const plain = Promise.resolve(1);
      `,
      'test/lazy.test.ts': `
        import { expect, test } from 'vitest';
        import { lazy, plain } from '../src/lazy';
        async function settle(p) { expect(await p.then((n) => n)).toBe(1); }
        test('project subclass', async () => { await settle(lazy); });
        test('Promise.resolve', async () => { await settle(plain); });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    expect(byName(tests, 'project subclass').suspicions).toContain('opaque_call');
    expect(byName(tests, 'project subclass').suspicions).not.toContain('target_not_called');
    // A promise is an object too, whose `then` may be replaced: opaque.
    expect(byName(tests, 'Promise.resolve').suspicions).toContain('opaque_call');
  });

  it('reads no variable an assertion only names inside a function it never runs', () => {
    const root = tempProject({
      'src/app.ts': 'export class App { on(handler: () => void) { handler(); } }\n',
      'test/closure.test.ts': `
        import { expect, it } from 'vitest';
        import { App } from '../src/app';
        it('closure only', () => {
          let hit = 0;
          new App().on(() => { hit++; });
          expect(() => hit).toBeDefined();
        });
        it('read', () => {
          let hit = 0;
          new App().on(() => { hit++; });
          expect(hit).toBe(1);
        });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    expect(byName(tests, 'closure only').suspicions).not.toContain('opaque_call');
    expect(byName(tests, 'closure only').targetCalls.some((call) => call.asserted)).toBe(false);
    // Read: linked to the project call that runs the closure, or inconclusive.
    expect(
      byName(tests, 'read').suspicions.includes('opaque_call') ||
        byName(tests, 'read').targetCalls.some((call) => call.asserted),
    ).toBe(true);
  });

  it('takes any invocation of a project value through a helper parameter for a possible project call', () => {
    const root = tempProject({
      'src/svc.ts': `${SERVICE}export class Thing { value = 1; }\nexport const tag = (parts: TemplateStringsArray) => parts.join('');\n`,
      'test/invoke.test.ts': `
        import { expect, test } from 'vitest';
        import { Thing, tag } from '../src/svc';
        function make(Ctor) { expect(new Ctor().value).toBe(1); }
        function viaReflect(Ctor) { expect(Reflect.construct(Ctor, []).value).toBe(1); }
        function tagged(fn) { expect(fn\`x\`).toBe('x'); }
        function asserted(value) { expect(value).toBeDefined(); }
        test('new', () => { make(Thing); });
        test('Reflect.construct', () => { viaReflect(Thing); });
        test('tagged template', () => { tagged(tag); });
        test('only asserted on', () => { asserted(Thing); });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    for (const name of ['new', 'Reflect.construct', 'tagged template'])
      expect(byName(tests, name).suspicions, name).toContain('opaque_call');
    // Handed only to an assertion, which reads it: no project call.
    expect(byName(tests, 'only asserted on').suspicions).not.toContain('opaque_call');
  });

  it("counts an earlier sibling suite's afterAll writer, and not its own suite's", () => {
    const root = tempProject({
      'src/app.ts': 'export class App { on(handler: () => void) { handler(); } }\n',
      'test/after-all.test.ts': `
        import { afterAll, describe, expect, it } from 'vitest';
        import { App } from '../src/app';
        let done = false;
        describe('first', () => {
          afterAll(() => { new App().on(() => { done = true; }); });
          it('inside', () => { expect(done).toBe(false); });
        });
        describe('second', () => {
          it('after the first suite', () => { expect(done).toBe(true); });
        });
      `,
    });
    const { tests } = inventory(root, vitest.recognition);

    expect(byName(tests, 'inside').suspicions).not.toContain('opaque_call');
    expect(byName(tests, 'after the first suite').suspicions).toContain('opaque_call');
  });
});
