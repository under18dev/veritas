import { VeritasConfig } from '@under18dev/veritas-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests, testId } from '../src/index.js';
import { tempProject } from './helpers.js';

describe('Vitest registration modifiers', () => {
  it('records modifiers, propagates describe.skip, and preserves nested suite paths', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/modifiers.test.ts': `
        import { describe, expect, it, test } from 'vitest';
        import { value } from '../src/value.js';
        it.skip('skipped', () => expect(value(1)).toBe(1));
        test.only('focused', () => expect(value(1)).toBe(1));
        test.todo('todo');
        test.concurrent('concurrent', () => expect(value(1)).toBe(1));
        describe.skip('outer', () => describe('inner', () => it('child', () => expect(value(1)).toBe(1))));
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const byName = (name: string) => {
      const test = inventory.tests.find((candidate) => candidate.name === name);

      if (!test) throw new Error(`missing test: ${name}`);

      return test;
    };

    expect(byName('skipped').modifiers).toContain('skip');
    expect(byName('focused').modifiers).toContain('only');
    expect(byName('todo').modifiers).toContain('todo');
    expect(byName('concurrent').modifiers).toContain('concurrent');
    expect(byName('child').modifiers).toContain('skip');
    expect(byName('child').suitePath).toEqual(['outer', 'inner']);
    expect(byName('child').id).toBe(testId('test/modifiers.test.ts', ['outer', 'inner'], 'child'));
  });

  it('records describe.each as a suite modifier and test.each as a test modifier', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/each.test.ts': `
        import { describe, expect, test } from 'vitest';
        import { value } from '../src/value.js';
        describe.each([[1]])('generated', (input) => {
          test.each([[input]])('row', ([item]) => expect(value(item)).toBe(item));
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const testCase = inventory.tests.at(0);

    if (!testCase) throw new Error('missing generated test');

    expect(testCase.suitePath).toEqual(['generated']);
    expect(testCase.modifiers).toContain('each');
  });

  it('registers the test of skipIf, runIf and for, not the call that makes the registration', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/conditional.test.ts': `
        import { describe, expect, test } from 'vitest';
        import { value } from '../src/value.js';
        test.skipIf(!('File' in globalThis))('conditional', () => { expect(value(1)).toBe(1); });
        describe.runIf(true)('suite', () => {
          test.for([1, 2])('row %i', (n) => { expect(value(n)).toBe(n); });
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.suitePath, t.modifiers])).toEqual([
      ['conditional', [], []],
      ['row %i', ['suite'], ['each']],
    ]);
    expect(inventory.tests.every((t) => t.targetCalls.some((call) => call.asserted))).toBe(true);
  });

  it('records it.fails as expected to fail', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/fails.test.ts': `
        import { expect, it } from 'vitest';
        import { value } from '../src/value.js';
        it.fails('inverted', () => expect(value(1)).toBe(2));
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests[0]?.modifiers).toEqual(['expected_failure']);
  });

  it('registers tests and suites of a tagged template table', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/table.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { value } from '../src/value.js';
        describe.each\`
          input
          \${1}
        \`('suite $input', ({ input }) => {
          it.each\`
            item
            \${2}
          \`('row $item', ({ item }) => expect(value(item + input)).toBe(item + input));
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.suitePath, t.modifiers])).toEqual([
      ['row $item', ['suite $input'], ['each']],
    ]);
  });
});

describe('full names static analysis cannot read', () => {
  it('records why a test runs under a name other than its suite path and title', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/names.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { value } from '../src/value.js';
        it.each([[4999]])('fee for %s', (total) => { value(total); expect(true).toBe(true); });
        for (const [t, f] of [[5000, 5000]]) it(\`fee for \${t}\`, () => { expect(value(t)).toBe(f); });
        for (const y of [1]) describe(\`dyn \${y}\`, () => {
          describe('inner', () => it('works', () => expect(value(y)).toBe(y)));
        });
        function shared() { it('shared', () => expect(value(1)).toBe(1)); }
        describe('plain', () => { it('exact', () => expect(value(1)).toBe(1)); shared(); });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.suitePath, t.inexactName])).toEqual([
      ['fee for %s', [], undefined],
      ['<dynamic test>', [], 'dynamic_title'],
      ['works', ['inner'], 'dynamic_suite'],
      ['shared', [], 'registered_in_function'],
      ['exact', ['plain'], undefined],
    ]);
    // Test ids stay as they were: the suite title that is not a literal is still left out of the suite path.
    expect(inventory.tests[2]?.id).toBe(testId('test/names.test.ts', ['inner'], 'works'));
    // `shared()` in the describe callback and the loops run code that may register tests.
    expect(inventory.files.find((f) => f.path === 'test/names.test.ts')?.inexactNames).toBe(
      'open_collection',
    );
  });

  it('marks a file whose collection runs anything but declarations and the runner API', () => {
    const header = [
      "import { assert, beforeEach, describe, expect, it, vi } from 'vitest';",
      "import { sharedSuite, helpers } from './shared-suite.js';",
      "import { value } from '../src/value.js';",
    ].join('\n');
    const open: Record<string, string> = {
      call: 'sharedSuite();',
      assigned: 'const registered = sharedSuite();',
      exported: 'export const s = sharedSuite();',
      forEach: '[sharedSuite].forEach((f) => f());',
      localForEach: 'const list = [1]; list.forEach((n) => value(n));',
      voided: 'void sharedSuite();',
      constructed: 'new Map();',
      constructedConst: 'const app = new Map();',
      and: 'value(1) && sharedSuite();',
      conditional: 'const x = value(1) ? sharedSuite() : null;',
      tried: 'try { sharedSuite(); } catch {}',
      switched: 'switch (value(1)) { default: sharedSuite(); }',
      labeled: 'outer: { sharedSuite(); }',
      iife: '(() => sharedSuite())();',
      awaited: 'await sharedSuite();',
      sideEffect: "import './shared-suite.js';",
      dynamicImport: "await import('./shared-suite.js');",
      tagged: 'const t = String.raw`x`;',
      method: 'helpers.run();',
      inDescribe: "describe('outer', () => { if (true) { helpers.run(); } });",
      passed: "describe('outer', sharedSuite);",
      eachRows: "describe.each(sharedSuite())('row %s', () => {});",
      enumMember: 'enum E { A = sharedSuite().length }',
      mockRedeclaredVar:
        "vi.mock('../src/value.js', (orig) => { var orig = sharedSuite; orig(); return {}; });",
      mockRedeclaredFunction:
        "vi.mock('../src/value.js', (orig) => { function orig() { sharedSuite(); } orig(); return {}; });",
      mockReassigned:
        "vi.mock('../src/value.js', async (orig) => { orig = sharedSuite; await orig(); return {}; });",
      mockFactoryReadsImport: "vi.mock('../src/value.js', () => ({ ...helpers, value: helpers.run }));",
      mockFactorySpreadsImport: "vi.mock('../src/value.js', () => ({ ...helpers }));",
      objectSpreadImport: 'const merged = { ...helpers };',
      mockBracket: "vi['mock']('../src/value.js', () => { sharedSuite(); return {}; });",
      mockComputedKey: "const key = 'mock'; vi[key]('../src/value.js', () => ({}));",
      mockByReference:
        "const factory = () => { sharedSuite(); return {}; }; vi.mock('../src/value.js', factory);",
      hoistedByReference: 'const h = vi.hoisted(helpers.run);',
      hookArgument: 'beforeEach(sharedSuite());',
      calledMock: 'vi.fn(() => sharedSuite())();',
      calledMockInConst: 'const r = vi.fn(() => sharedSuite())();',
      calledHoisted: 'vi.hoisted(() => () => sharedSuite())();',
      expectFunction: 'expect(() => sharedSuite()).toThrow();',
      assertFunction: 'assert.throws(() => sharedSuite());',
      waitFor: 'vi.waitFor(() => sharedSuite());',
      expectFunctionReference:
        "import { pkgRun } from 'external-test-package'; const f = () => pkgRun(); expect(f).toThrow();",
      expectFunctionDeclaration:
        "import { pkgRun } from 'external-test-package'; function f2() { pkgRun(); } expect(f2).toThrow();",
      expectMock: 'const m = vi.fn(() => sharedSuite()); expect(m).toThrow();',
      assertMember: 'assert.throws(helpers.run);',
      waitForReference:
        "import { pkgRun } from 'external-test-package'; const g = () => pkgRun(); vi.waitFor(g);",
      pollImport: 'expect.poll(sharedSuite);',
      callbackDefault: 'expect((run = sharedSuite) => run()).not.toThrow();',
      callbackParameter: 'expect((run: () => void) => run()).not.toThrow();',
      expectConditional: 'expect(true ? sharedSuite : sharedSuite).not.toThrow();',
      expectAnd: 'expect(true && sharedSuite).toBeDefined();',
      assertNullish: 'assert.throws(null ?? sharedSuite);',
      waitForComma: 'vi.waitFor((0, sharedSuite));',
      expectAs: 'expect(sharedSuite as any).toBeDefined();',
      expectMockOf: 'expect(vi.fn(sharedSuite)).not.toThrow();',
      matcherMethod:
        'const v = { a: 1 }; expect(v).toEqual(expect.objectContaining({ a: { asymmetricMatch() { sharedSuite(); return true; } } }));',
      matcherArrow:
        'const v = { a: 1 }; expect(v).toEqual(expect.objectContaining({ a: { asymmetricMatch: () => { sharedSuite(); return true; } } }));',
      expectMocked: 'expect(vi.mocked(sharedSuite)).not.toThrow();',
      expectMockedDeep: 'expect(vi.mocked(helpers.run, true)).not.toThrow();',
      expectSpyReset:
        "expect(vi.spyOn(helpers, 'run').mockImplementation(() => [1]).mockReset()).not.toThrow();",
      expectSpyRestored:
        "vi.restoreAllMocks();\nexpect(vi.spyOn(helpers, 'run').mockImplementation(() => [1])).not.toThrow();",
      expectSpyOriginal: "expect(vi.spyOn(helpers, 'run')).not.toThrow();",
      customMatcher:
        "expect.extend({ toRegister() { sharedSuite(); return { pass: true, message: () => '' }; } });\nexpect(0).toRegister();",
      customMatcherNegated: 'expect(0).not.toRegister();',
      builtInNameMatcher:
        "expect.extend({ toBe() { sharedSuite(); return { pass: true, message: () => '' }; } });\nexpect(1).toBe(1);",
      matchersFromPackage: "import { matchers } from 'external-test-package';\nexpect.extend(matchers);",
      matchersSpread: 'expect.extend({ ...helpers });',
      matcherByReference: 'expect.extend({ toBe: sharedSuite });\nexpect(0).toBe(0);',
      matcherFromPackage:
        "import { pkgRun } from 'external-test-package';\nexpect.extend({ toBe: pkgRun });\nexpect(0).toBe(0);",
      shadowedHook:
        "describe('suite', () => { const beforeEach = sharedSuite; beforeEach(); it.each(['own'])('%s', () => {}); });",
      shadowedHookFunction:
        "import { pkgRun } from 'external-test-package';\ndescribe('suite', () => { function afterAll() { pkgRun(); } afterAll(); it('x', () => {}); });",
      supportHook: "import { beforeEach as setup } from './support-hooks.js';\nsetup(() => {});",
      supportHookSameName: "import { afterAll } from './support-hooks.js';\nafterAll(() => {});",
      returnsFunction: 'expect(() => sharedSuite).not.toThrow();',
      returnsFunctionFromBlock: 'expect(() => { return sharedSuite; }).not.toThrow();',
      expectSpyOnce: "expect(vi.spyOn(helpers, 'run').mockImplementationOnce(() => [1])).not.toThrow();",
      expectMockImplementation: 'expect(vi.fn().mockImplementation(sharedSuite)).not.toThrow();',
      expectSpyImplementation:
        "expect(vi.spyOn(console, 'log').mockImplementation(() => sharedSuite())).not.toThrow();",
      expectImport: 'expect(sharedSuite).toBeDefined();',
      mockedPathNotLiteral: "const where = './x.js'; vi.mock(where);",
      testArgument: "it('x', sharedSuite());",
      titleArgument: 'describe(String(sharedSuite()), () => {});',
      runnerApiArgument: 'const spy = vi.fn(sharedSuite());',
      taggedTable: `it.each\`a\n\${sharedSuite()}\`('t $a', () => {});`,
      destructuredDefault: 'const { cleanup = sharedSuite() } = {};',
      nestedArrayDefault: 'const [[first = sharedSuite()]] = [[]];',
      computedBindingKey: 'const { [String(sharedSuite())]: picked } = {};',
      describeInConst: "const suite = describe('shared', sharedSuite);",
      describeInConstBody: "export const s = describe('shared', () => { sharedSuite(); });",
      describeInArray: "const all = [describe('shared', () => { helpers.run(); })];",
      describeDefault: "describe('d', (x = sharedSuite()) => {});",
      describeDestructured: "describe('d', ({ a = sharedSuite() } = {}) => {});",
      hoisted: 'const h = vi.hoisted(() => sharedSuite());',
      mockFactory: "vi.mock('../src/value.js', () => { sharedSuite(); return {}; });",
      doMockFactory: "vi.doMock('../src/value.js', () => ({ value: sharedSuite() }));",
      mockFactoryImport:
        "vi.mock('../src/value.js', async () => ({ ...(await import('./shared-suite.js')) }));",
    };
    const closed: Record<string, string> = {
      plain:
        "describe('suite', () => { beforeEach(() => { value(1); }); it('works', () => { value(2); expect(1).toBe(1); }); });",
      constants:
        "const cases = [{ name: 'a', total: 1 }]; const fee = (n: number) => value(n); it.each(cases)('$name', ({ total }) => { expect(fee(total)).toBe(total); });",
      runnerApi:
        "vi.mock('../src/value.js'); const spy = vi.fn(); expect.extend({}); it('spy', () => { spy(); });",
      declarations:
        "type T = number; interface I { a: T } function helper() { return value(1); } class Box { static size = 1; } it('d', () => { helper(); new Box(); });",
      template: `const n = 1; it(\`case \${n}\`, () => { expect(value(n)).toBe(n); });`,
      testByReference: "it('ref', () => { double(1); }); it('ref2', double);",
      destructuredLiterals: "const { a = 1, b: [c = 'x'] } = { a: 2, b: [] }; it('d', () => { value(a); });",
      taggedTableClosed: `it.each\`a\n\${1}\`('t $a', ({ a }) => { expect(value(a)).toBe(a); });`,
      mockSpy: "vi.mock('../src/value.js', { spy: true }); it('s', () => {});",
      mockBracketClosed: "vi['mock']('../src/value.js', () => ({ value: vi.fn() })); it('b', () => {});",
      describeInConstClosed: "const suite = describe('own', () => { it('x', () => { value(1); }); });",
      enumLiteral: "enum E { A = 1, B = A + 1, C = 'c' } it('e', () => { expect(E.B).toBe(2); });",
      mockOriginal:
        "vi.mock('../src/value.js', async (orig) => ({ ...(await orig<object>()), value: vi.fn() })); it('m', () => {});",
      mockOriginalBlock:
        "vi.mock('../src/value.js', async (importOriginal) => { const actual = await importOriginal<object>(); return { ...actual, value: vi.fn() }; }); it('m', () => {});",
      hoistedFn: "const mocks = vi.hoisted(() => ({ value: vi.fn() })); it('h', () => { mocks.value(); });",
      mockOriginalMembers:
        "vi.mock('../src/value.js', async (importOriginal) => { const mod = await importOriginal<any>(); return { ...mod, f: vi.fn(), g: mod.value, h: mod.nested.deep }; }); it('m', () => {});",
      mockOriginalInline:
        "vi.mock('../src/value.js', async (importOriginal) => ({ ...(await importOriginal<any>()), g: (await importOriginal<any>()).value })); it('m', () => {});",
      mockNotCalled: "const f = vi.fn(() => double(1)); it('f', () => { f(); });",
      implementationNotCalled:
        "const g = vi.fn().mockImplementation(() => double(1)); it('g', () => { g(); });",
      expectValue: "const n = 1; const row = { a: [1, 'x'] }; expect(n).toBe(1); expect(row).toEqual(row);",
      expectChoice: 'const flag = true; expect(flag ? 1 : 2).toBe(1); expect(() => flag).not.toThrow();',
      typeofEval:
        "type E = typeof eval; const kind = typeof eval; it('t', () => { expect(kind).toBe('function'); });",
      functionTypeChecks:
        "it('f', () => { const f = vi.fn(); f(() => 1); expect(f).toHaveBeenCalledWith(expect.any(Function)); expect(f).toBeInstanceOf(Function); });",
      nestedMatchers:
        "const v = { a: 1 }; expect(v).toEqual(expect.objectContaining({ a: expect.any(Number), b: expect.stringContaining('x'), c: [1, /r/] }));",
      expectMockOfInline: 'expect(vi.fn(() => 1)).not.toThrow();',
      expectFreshMatcher:
        'const n = 1; expect(n).toEqual(expect.any(Number)); expect({ a: n }).toEqual(expect.objectContaining({ a: n }));',
      expectSpyOnData: "const plain = { m: 1 }; expect(vi.spyOn(plain, 'm')).toBeDefined();",
      expectSpyReplaced:
        "const n = 1; expect(vi.spyOn(console, 'log').mockImplementation(() => n)).toBeDefined();",
      spyOn: "vi.spyOn(console, 'log'); it('s', () => {});",
      expectExtend:
        "expect.extend({ toBeTwo(received: number) { return { pass: received === 2, message: () => 'two' }; } });",
      automockPlain: "vi.mock('./pure-helper.js'); it('a', () => {});",
    };
    // Modules a mock loads run their code too: one that registers tests registers them under this file.
    const loadsRegistering: Record<string, string> = {
      importActual:
        "vi.mock('../src/value.js', async () => ({ ...(await vi.importActual('./shared-suite.js')) })); it('x', () => {});",
      returnsImportActual:
        "vi.mock('../src/value.js', () => vi.importActual('./shared-suite.js')); it('x', () => {});",
      automock: "vi.mock('./shared-suite.js'); it('x', () => {});",
      namespacedLoader:
        "import * as v from 'vitest'; v.vi.importActual('./shared-suite.js'); it('x', () => {});",
    };
    const files: Record<string, string> = {
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/shared-suite.ts': [
        "import { expect, it } from 'vitest';",
        "import { value } from '../src/value.js';",
        "export function sharedSuite() { it('is shared', () => expect(value(1)).toBe(1)); return [1]; }",
        'export const helpers = { run: sharedSuite };',
      ].join('\n'),
      'test/pure-helper.ts': 'export const double = (n: number) => n * 2;\n',
      // A support module whose functions have hook names but call a package.
      'test/support-hooks.ts': [
        "import { pkgRun } from 'external-test-package';",
        'export function beforeEach(fn: () => void) { pkgRun(); fn(); }',
        'export function afterAll(fn: () => void) { pkgRun(); fn(); }',
      ].join('\n'),
      'test/imports-registering.test.ts': `${header}\nit('own', () => {});\n`,
      // A helper that runs a package's shared suite when it loads; project code may build values at load.
      'test/open-helper.ts': [
        "import { sharedSuite } from 'external-test-package';",
        'sharedSuite();',
        'export const helperValue = 1;',
        'export type HelperType = number;',
      ].join('\n'),
      'src/store.ts': 'export const store = new Map<string, number>();\n',
      'test/imports-open.test.ts':
        "import { expect, it } from 'vitest';\nimport { helperValue } from './open-helper.js';\nit('o', () => { expect(helperValue).toBe(1); });\n",
      'test/imports-open-type.test.ts':
        "import { it } from 'vitest';\nimport type { HelperType } from './open-helper.js';\nconst n: HelperType = 1;\nit('t', () => {});\n",
      'test/imports-project.test.ts':
        "import { expect, it } from 'vitest';\nimport { store } from '../src/store.js';\nit('p', () => { expect(store.size).toBe(0); });\n",
      // Support modules that load no package may run any code when they load.
      'test/fixtures.ts': [
        "import { readFileSync } from 'node:fs';",
        "import path from 'path';",
        "export const big = 'a'.repeat(64);",
        'export const seen = new Map<string, string>();',
        'export const read = (file: string) => readFileSync(path.join(file), "utf8");',
        'export function prepare() { seen.set(big, big); return big.length; }',
      ].join('\n'),
      'test/imports-fixtures.test.ts':
        "import { expect, it } from 'vitest';\nimport { big, prepare } from './fixtures.js';\nconst size = prepare();\nprepare();\nit('f', () => { expect(big.length).toBe(size); });\n",
      // One that loads a package but only declares at its top level is safe too.
      'test/package-declarations.ts': [
        "import { pkg } from 'external-test-package';",
        'export const make = () => pkg();',
      ].join('\n'),
      'test/imports-package-declarations.test.ts':
        "import { it } from 'vitest';\nimport { make } from './package-declarations.js';\nit('m', () => { make(); });\n",
      // Calling, at collection time, a local function whose module loads a package may reach it.
      'test/calls-package-function.test.ts':
        "import { it } from 'vitest';\nimport { make } from './package-declarations.js';\nmake();\nit('m', () => {});\n",
      // A same-file function, in a file that loads no package, may be called.
      'test/calls-own-function.test.ts':
        "import { expect, it } from 'vitest';\nfunction rows() { return [1, 2]; }\nconst cases = rows();\nrows();\nit('o', () => { expect(cases).toHaveLength(2); });\n",
      // Code reached by a computed name is not followed.
      'test/dynamic-helper.ts': "export const run = () => (globalThis as any)['it']('x', () => {});\n",
      'test/imports-dynamic.test.ts':
        "import { it } from 'vitest';\nimport { run } from './dynamic-helper.js';\nit('d', () => { run; });\n",
      'test/eval-helper.ts': "export const value = eval('1');\n",
      'test/imports-eval.test.ts':
        "import { it } from 'vitest';\nimport { value } from './eval-helper.js';\nit('e', () => { value; });\n",
    };
    for (const [name, code] of Object.entries(open))
      files[`test/open-${name}.test.ts`] = `${header}\n${code}\n`;
    for (const [name, code] of Object.entries(loadsRegistering))
      files[`test/loads-${name}.test.ts`] = ["import { it, vi } from 'vitest';", code, ''].join('\n');
    for (const [name, code] of Object.entries(closed))
      files[`test/closed-${name}.test.ts`] = [
        "import { beforeEach, describe, expect, it, vi } from 'vitest';",
        "import { double } from './pure-helper.js';",
        "import { value } from '../src/value.js';",
        code,
        '',
      ].join('\n');
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root: tempProject(files),
      config: VeritasConfig.parse({}),
    });
    const marked = (file: string) => inventory.files.find((f) => f.path === file)?.inexactNames;

    expect(
      Object.keys(open)
        .map((name) => [name, marked(`test/open-${name}.test.ts`)])
        .filter(([, reason]) => reason !== 'open_collection'),
    ).toEqual([]);
    for (const name of Object.keys(closed))
      expect(marked(`test/closed-${name}.test.ts`), name).toBeUndefined();
    for (const name of Object.keys(loadsRegistering))
      expect(marked(`test/loads-${name}.test.ts`), name).toBe('imported_registrations');
    expect(marked('test/imports-open.test.ts')).toBe('imported_open_module');
    // `import type` is erased; project code is not held to the allowlist.
    expect(marked('test/imports-open-type.test.ts')).toBeUndefined();
    expect(marked('test/imports-project.test.ts')).toBeUndefined();
    expect(marked('test/imports-fixtures.test.ts')).toBeUndefined();
    expect(marked('test/imports-package-declarations.test.ts')).toBeUndefined();
    expect(marked('test/calls-package-function.test.ts')).toBe('open_collection');
    expect(marked('test/calls-own-function.test.ts')).toBeUndefined();
    expect(marked('test/imports-dynamic.test.ts')).toBe('imported_open_module');
    expect(marked('test/imports-eval.test.ts')).toBe('imported_open_module');
    // Importing a module that registers tests is enough: its tests run under this file.
    expect(marked('test/imports-registering.test.ts')).toBe('imported_registrations');
  });

  it('marks files that reach the registration API in a form the inventory does not read', () => {
    const helpers: Record<string, string> = {
      constInFunction:
        "import { expect, it } from 'vitest';\nexport function shared() { const register = it; register('x', () => { expect(1).toBe(1); }); }",
      constTop:
        "import { it } from 'vitest';\nconst t = it;\nt('x', () => {});\nexport const shared = () => 1;",
      destructuredNamespace:
        "import * as v from 'vitest';\nconst { it: t } = v;\nt('x', () => {});\nexport const shared = () => 1;",
      arrayElement: "import { it } from 'vitest';\n[it][0]('x', () => {});\nexport const shared = () => 1;",
      namespaceMember:
        "import * as v from 'vitest';\nexport function shared() { const f = v.test; f('x', () => {}); }",
      jestGlobal: "export function shared() { const f = it; f('x', () => {}); }",
      globalObject: "export function shared() { const g = globalThis as any; g.it('x', () => {}); }",
      exported: "import { it } from 'vitest';\nexport { it };\nexport const shared = () => 1;",
      passed:
        "import { it } from 'vitest';\nconst keep = (f: unknown) => f;\nkeep(it);\nexport const shared = () => 1;",
      barrel: "export * from 'vitest';\nexport const shared = () => 1;",
      requireDestructured:
        "export function shared() { const { it: t } = require('vitest'); t('x', () => {}); }",
      requireMember: "export function shared() { require('vitest').it('x', () => {}); }",
      dynamicImport:
        "export async function shared() { const { it: t } = await import('vitest'); t('x', () => {}); }",
      importActual:
        "import { vi } from 'vitest';\nexport async function shared() { const m: any = await vi.importActual('vitest'); m.it('x', () => {}); }",
      importEquals: "import v = require('vitest');\nexport function shared() { v.it('x', () => {}); }",
      createRequireAlias:
        "import { createRequire } from 'node:module';\nconst cr = createRequire;\nexport function shared() { cr(import.meta.url)('vitest').it('x', () => {}); }",
      cjsCreateRequireDestructured:
        "const { createRequire } = require('node:module');\nexport function shared() { createRequire(__filename)('external-shared-suite').sharedSuite(); }",
      cjsCreateRequireMember:
        "export function shared() { require('module').createRequire(__filename)('external-shared-suite').sharedSuite(); }",
      cjsCreateRequireNamespace:
        "const m = require('node:module');\nexport function shared() { m.createRequire(__filename)('external-shared-suite').sharedSuite(); }",
      cjsModulePassed:
        "const m = require('node:module');\nexport const keep = [m];\nexport function shared() { return 1; }",
      evalAlias: 'export function shared() { const execute = eval; execute("it(\'hidden\', () => {})"); }',
      evalIndirect: 'export function shared() { (0, eval)("it(\'hidden\', () => {})"); }',
      evalReflect: 'export function shared() { Reflect.apply(eval, null, ["it(\'hidden\', () => {})"]); }',
      functionConstructor:
        'export function shared() { const F = (() => {}).constructor as any; new F("it(\'hidden\', () => {})")(); }',
      functionPrototype:
        'export function shared() { const F = (Function as any).prototype.constructor; F("it(\'hidden\', () => {})")(); }',
      arrayConstructor:
        'export function shared() { ([] as any).constructor.constructor("it(\'hidden\', () => {})")(); }',
      objectConstructor:
        'export function shared() { ({} as any).constructor.constructor("it(\'hidden\', () => {})")(); }',
      prototypeConstructor:
        'export function shared() { Object.getPrototypeOf(async function () {}).constructor("it(\'hidden\', () => {})")(); }',
      bracketConstructor:
        "export function shared() { const o: any = shared; o['constructor'](\"it('hidden', () => {})\")(); }",
      computedCall:
        "export function shared(k = 'constructor') { const o: any = shared; o[k](\"it('hidden', () => {})\")(); }",
      matcherMember:
        "import { expect } from 'vitest';\nexport function shared() { (expect.any(Function) as any).sample.constructor('x')(); }",
      castKey:
        "export function shared() { const k = 'constructor' as 'a'; const f: any = shared; f[k](\"it('hidden', () => {})\")(); }",
      parameterKey:
        "export function shared(k: 'a' = 'constructor' as any) { const f: any = shared; f[k](\"it('hidden', () => {})\")(); }",
      letKey:
        "let k: 'a' = 'a';\nk = 'constructor' as 'a';\nexport function shared() { const f: any = shared; f[k](\"it('hidden', () => {})\")(); }",
      parsedKey:
        "export function shared() { const k = JSON.parse('\"constructor\"') as 'a'; const f: any = shared; f[k](\"it('hidden', () => {})\")(); }",
      computedAsCall:
        "export function shared(k = 'constructor') { const f: any = shared; (f[k] as any)(\"it('hidden', () => {})\")(); }",
      computedParenCall:
        "export function shared(k = 'constructor') { const f: any = shared; (f[k])(\"it('hidden', () => {})\")(); }",
      computedNonNullCall:
        "export function shared(k = 'constructor') { const f: any = shared; f[k]!(\"it('hidden', () => {})\")(); }",
      computedCommaCall:
        "export function shared(k = 'constructor') { const f: any = shared; (0, f[k])(\"it('hidden', () => {})\")(); }",
      computedAlias:
        "export function shared(k = 'constructor') { const f: any = shared; const g = f[k]; g(\"it('hidden', () => {})\")(); }",
      computedPassed:
        "export function shared(k = 'constructor') { const f: any = shared; [\"it('hidden', () => {})\"].map(f[k]).forEach((h: any) => h()); }",
      computedMemberCall:
        "export function shared(k = 'constructor') { const f: any = shared; f[k].call(null, \"it('hidden', () => {})\")(); }",
      computedNew:
        "export function shared(k = 'constructor') { const f: any = shared; new (f[k])(\"it('hidden', () => {})\")(); }",
      computedTagged:
        "export function shared(k = 'constructor') { const f: any = shared; f[k]`it('hidden', () => {})`(); }",
      computedReturned:
        "export function shared(k = 'constructor') { const f: any = shared; const get = () => f[k]; get()(\"it('hidden', () => {})\")(); }",
      computedAliasRead:
        "export function shared(k = 'constructor') { const f: any = shared; const g = f[k]; const h = g.bind(null); h(\"it('hidden', () => {})\")(); }",
      objectKeys:
        "export function shared() { const f: any = shared; for (const k of Object.keys({ constructor: 1 }) as 'a'[]) f[k](\"it('hidden', () => {})\")(); }",
      castKeyWrapped:
        "export function shared() { const k = 'constructor' as 'a'; const f: any = shared; (f[k] as any)(\"it('hidden', () => {})\")(); }",
      computedDestructured:
        "export function shared(k = 'constructor') { const { [k]: g }: any = shared; g(\"it('hidden', () => {})\")(); }",
      builtinVm:
        "export function shared() { (process as any).getBuiltinModule('node:vm').runInThisContext(\"it('hidden', () => {})\"); }",
      builtinVmBare:
        "export function shared() { const vm: any = process.getBuiltinModule('vm'); vm.runInThisContext(\"it('hidden', () => {})\"); }",
      builtinRunner:
        "export function shared() { (process as any).getBuiltinModule('vitest').it('x', () => {}); }",
      builtinName:
        "export function shared(name = 'node:vm') { (process as any).getBuiltinModule(name).runInThisContext(\"it('hidden', () => {})\"); }",
      builtinValue:
        "export function shared() { const load: any = process.getBuiltinModule; load('vm').runInThisContext(\"it('hidden', () => {})\"); }",
      builtinDestructured:
        "export function shared() { const { getBuiltinModule: load }: any = process; load('vm').runInThisContext(\"it('hidden', () => {})\"); }",
      builtinCreateRequire:
        "export function shared() { (process as any).getBuiltinModule('module').createRequire(import.meta.url)('vitest').it('x', () => {}); }",
      builtinCreateRequireBound:
        "const m: any = process.getBuiltinModule('node:module');\nconst load = m.createRequire(import.meta.url);\nexport function shared() { load('vitest').it('x', () => {}); }",
      importedCreateRequire:
        "export async function shared() { const { createRequire } = await import('node:module'); createRequire(import.meta.url)('vitest').it('x', () => {}); }",
      importedCreateRequireMember:
        "export async function shared() { (await import('module')).createRequire(import.meta.url)('vitest').it('x', () => {}); }",
      importedModuleNamespace:
        "export async function shared() { const m = await import('node:module'); m.createRequire(import.meta.url)('vitest').it('x', () => {}); }",
      importedCreateRequireAlias:
        "export async function shared() { const { createRequire } = await import('node:module'); const cr = createRequire; cr(import.meta.url)('vitest').it('x', () => {}); }",
      importedModuleThen:
        "export function shared() { import('node:module').then((m: any) => m.createRequire(import.meta.url)('vitest').it('x', () => {})); }",
      moduleClassLoad:
        "import { Module } from 'node:module';\nexport function shared() { (Module as any)._load('node:vm').runInThisContext(\"it('hidden', () => {})\"); }",
      moduleDefaultLoad:
        "import m from 'module';\nexport function shared() { (m as any)._load('vitest').it('x', () => {}); }",
      moduleNamespaceLoad:
        "import * as m from 'module';\nexport function shared() { (m as any).Module._load('vitest').it('x', () => {}); }",
      moduleImportEqualsLoad:
        "import m = require('module');\nexport function shared() { (m as any)._load('vitest').it('x', () => {}); }",
      moduleRequireLoad: "export function shared() { require('module')._load('vitest').it('x', () => {}); }",
      moduleRequireDestructured:
        "export function shared() { const { Module } = require('node:module'); Module._load('vitest').it('x', () => {}); }",
      moduleImportedLoad:
        "export async function shared() { const { Module }: any = await import('node:module'); Module._load('vitest').it('x', () => {}); }",
      moduleBuiltinLoad:
        "export function shared() { (process as any).getBuiltinModule('module').Module._load('vitest').it('x', () => {}); }",
      moduleRegister:
        "import { register } from 'node:module';\nexport function shared() { register('./hooks.mjs', import.meta.url); }",
      moduleReexport: "export { Module } from 'node:module';\nexport const shared = () => 1;",
      vmRun:
        "import { runInThisContext } from 'node:vm';\nexport function shared() { runInThisContext(\"it('hidden', () => {})\"); }",
      vmScript:
        "import vm from 'vm';\nexport function shared() { new vm.Script(\"it('hidden', () => {})\").runInThisContext(); }",
      vmRequire:
        "export function shared() { require('node:vm').runInThisContext(\"it('hidden', () => {})\"); }",
      requireAlias: "export function shared() { const r = require; r('vitest').it('x', () => {}); }",
      requireCall: "export function shared() { require.call(null, 'vitest').it('x', () => {}); }",
      moduleRequire: "export function shared() { module.require('vitest').it('x', () => {}); }",
      mainModuleRequire:
        "export function shared() { (process as any).mainModule.require('vitest').it('x', () => {}); }",
      mainModuleValue: 'export function shared() { const m: any = process.mainModule; m.load(); }',
      // Ambient declarations describe the globals; they shadow nothing.
      ambientIt: "declare const it: any;\nexport function shared() { const f = it; f('hidden', () => {}); }",
      ambientGlobalThis:
        "declare const globalThis: any;\nexport function shared() { const g = globalThis; g.it('x', () => {}); }",
      ambientModuleLoad:
        "declare const module: any;\nexport function shared() { module.constructor._load('vitest').it('x', () => {}); }",
      ambientModuleCreateRequire:
        "declare const module: any;\ndeclare const __filename: string;\nexport function shared() { module.constructor.createRequire(__filename)('vitest').it('x', () => {}); }",
      declareGlobal:
        "declare global { const it: any }\nexport function shared() { const f = it; f('x', () => {}); }",
    };
    const files: Record<string, string> = {
      'test/pure-build.ts':
        "export const build = () => ({ a: 1 });\nexport const where = () => require.resolve('./pure-build.js');\n",
      'test/builds.test.ts':
        "import { expect, it } from 'vitest';\nimport { build, where } from './pure-build.js';\nconst m = build();\nwhere();\nit('b', () => { expect(m.a).toBe(1); });\n",
      'test/barrel-user.ts':
        "import { test as t } from './helper-barrel.js';\nexport function shared() { t('x', () => {}); }\n",
      'test/uses-barrel-user.test.ts':
        "import { it } from 'vitest';\nimport { shared } from './barrel-user.js';\nshared();\nit('u', () => {});\n",
      'test/own-escape.test.ts':
        "import { expect, it } from 'vitest';\nfunction later() { const r = it; r('y', () => {}); }\nlater();\nit('o', () => { expect(1).toBe(1); });\n",
    };
    for (const [name, code] of Object.entries(helpers)) {
      files[`test/helper-${name}.ts`] = code;
      files[`test/uses-${name}.test.ts`] = [
        "import { expect, it } from 'vitest';",
        `import { shared } from './helper-${name}.js';`,
        'shared();',
        "it('own', () => { expect(1).toBe(1); });",
        '',
      ].join('\n');
    }
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root: tempProject(files),
      config: VeritasConfig.parse({}),
    });
    const marked = (file: string) => inventory.files.find((f) => f.path === file)?.inexactNames;

    for (const name of Object.keys(helpers)) expect(marked(`test/uses-${name}.test.ts`), name).toBeDefined();
    expect(marked('test/uses-barrel-user.test.ts')).toBeDefined();
    expect(marked('test/own-escape.test.ts')).toBe('open_collection');
    expect(marked('test/builds.test.ts')).toBeUndefined();
  });

  it('follows what local modules reach through other modules, in cycles too, and what local calls are given', () => {
    const root = tempProject({
      // A helper whose top level calls a local function that reaches a package.
      'test/bridge.ts':
        "import { sharedSuite } from 'external-test-package';\nexport function runSharedSuite() { return sharedSuite(); }\n",
      'test/reaches-package.ts':
        "import { runSharedSuite } from './bridge.js';\nexport const value = runSharedSuite();\n",
      'test/uses-reaching.test.ts':
        "import { it } from 'vitest';\nimport { value } from './reaches-package.js';\nit('r', () => { value; });\n",
      // Two helpers that load a package and call each other's export at their top level.
      'test/cycle-a.ts':
        "import { pkg } from 'external-test-package';\nimport { b } from './cycle-b.js';\nexport function a() { return pkg; }\nexport const x = b();\n",
      'test/cycle-b.ts':
        "import { pkg } from 'external-test-package';\nimport { a } from './cycle-a.js';\nexport function b() { return pkg; }\nexport const y = a();\n",
      'test/uses-cycle.test.ts':
        "import { it } from 'vitest';\nimport { x } from './cycle-a.js';\nit('c', () => { x; });\n",
      // A local function given something callable from a package.
      'test/run-helper.ts': 'export function run(options: { fn: () => unknown }) { return options.fn(); }\n',
      'test/passes-package-function.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun({ fn: sharedSuite });\nit('p', () => {});\n",
      'test/passes-spread.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun({ ...{ fn: sharedSuite } });\nit('p', () => {});\n",
      'test/passes-inline.test.ts':
        "import { it } from 'vitest';\nimport { run } from './run-helper.js';\nconst n = 2;\nrun({ fn: () => n });\nit('p', () => {});\n",
      'test/passes-conditional.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun(true ? sharedSuite : sharedSuite);\nit('p', () => {});\n",
      'test/passes-and.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun(true && sharedSuite);\nit('p', () => {});\n",
      'test/passes-nullish.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun(null ?? sharedSuite);\nit('p', () => {});\n",
      'test/passes-comma.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun((0, sharedSuite));\nit('p', () => {});\n",
      'test/passes-as.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun(sharedSuite as any);\nit('p', () => {});\n",
      'test/passes-nonnull.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun(sharedSuite!);\nit('p', () => {});\n",
      'test/passes-inline-choice.test.ts':
        "import { it } from 'vitest';\nimport { run } from './run-helper.js';\nconst flag = true;\nrun(flag ? () => 1 : () => 2);\nit('p', () => {});\n",
      // A helper that compares constructors and prototypes, and calls a method named by a literal-typed key.
      'test/plain-reflection.ts': [
        'export function shared(cause: unknown, item: object) {',
        '  const o = { a: () => 1, b: () => 2 };',
        "  const key: 'a' | 'b' = 'a';",
        '  return (cause instanceof Error && cause.constructor === Error) || Object.getPrototypeOf(item) === null || o[key]();',
        '}',
      ].join('\n'),
      // A helper reading members through computed keys only to compare, count, convert or interpolate them.
      'test/plain-indexing.ts': [
        'export function shared(xs: string[], m: Record<string, string>, k: string) {',
        '  let n = 0n;',
        '  for (let i = 0; i < xs.length; i++) {',
        '    const x = xs[i];',
        "    if (x !== '' && xs[i + 1] !== x) n += BigInt(xs[i]) + BigInt(x.length);",
        '    xs[i] = x.padStart(4);',
        '  }',
        "  return m[k] === 'a' || typeof m[k] === 'string' || `$" + '{m[k]}`.length > n || m[k].length > 0;',
        '}',
      ].join('\n'),
      'test/uses-plain-indexing.test.ts':
        "import { it } from 'vitest';\nimport { shared } from './plain-indexing.js';\nshared([], {}, 'a');\nit('r', () => {});\n",
      // A helper loading builtins at run time, and a local module through a require made from an imported module.
      'test/builtin-loads.ts': [
        "import { builtinModules, isBuiltin } from 'node:module';",
        "export function exists() { return (process as any).getBuiltinModule('node:fs').existsSync('x') || isBuiltin('fs') || builtinModules.length > 0; }",
        'export async function local() {',
        "  const { createRequire } = await import('node:module');",
        "  return createRequire(import.meta.url)('./plain-reflection.js');",
        '}',
      ].join('\n'),
      'test/uses-builtin-loads.test.ts':
        "import { it } from 'vitest';\nimport { exists, local } from './builtin-loads.js';\nexists(); local();\nit('r', () => {});\n",
      'test/uses-plain-reflection.test.ts':
        "import { it } from 'vitest';\nimport { shared } from './plain-reflection.js';\nshared(1, {});\nit('r', () => {});\n",
      // A setup helper registering matchers that call a package.
      'test/matchers-helper.ts':
        "import { expect } from 'vitest';\nimport { pkgRun } from 'external-test-package';\nexpect.extend({ toBe() { pkgRun(); return { pass: true, message: () => '' }; } });\nexport const ready = true;\n",
      'test/uses-matchers-helper.test.ts':
        "import { expect, it } from 'vitest';\nimport { ready } from './matchers-helper.js';\nit('m', () => { expect(ready).toBe(true); });\n",
      // What a function passed to a local call returns may be called in turn.
      'test/passes-returning.test.ts':
        "import { it } from 'vitest';\nimport { sharedSuite } from 'external-test-package';\nimport { run } from './run-helper.js';\nrun({ fn: () => sharedSuite });\nit('p', () => {});\n",
      'test/passes-returning-inline.test.ts':
        "import { it } from 'vitest';\nimport { run } from './run-helper.js';\nrun({ fn: () => () => 1 });\nit('p', () => {});\n",
      // createRequire makes a require the helper can load anything with.
      'test/created-require.ts':
        "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport function shared() { return load('external-test-package').sharedSuite(); }\n",
      'test/created-require-name.ts':
        "import * as m from 'module';\nconst r = m.createRequire(import.meta.url);\nexport function shared(name: string) { return r(name); }\n",
      'test/created-require-runner.ts':
        "import { createRequire as make } from 'module';\nexport function shared() { return make(import.meta.url)('vitest').it('x', () => {}); }\n",
      'test/created-require-passed.ts':
        "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport const keep = [load];\nexport function shared() { return 1; }\n",
      'test/uses-created-require.test.ts':
        "import { it } from 'vitest';\nimport { shared } from './created-require.js';\nshared();\nit('u', () => {});\n",
      'test/uses-created-require-name.test.ts':
        "import { it } from 'vitest';\nimport { shared } from './created-require-name.js';\nit('u', () => { shared; });\n",
      'test/uses-created-require-runner.test.ts':
        "import { it } from 'vitest';\nimport { shared } from './created-require-runner.js';\nit('u', () => { shared; });\n",
      'test/uses-created-require-passed.test.ts':
        "import { it } from 'vitest';\nimport { shared } from './created-require-passed.js';\nit('u', () => { shared; });\n",
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const marked = (file: string) => inventory.files.find((f) => f.path === file)?.inexactNames;

    expect(marked('test/uses-reaching.test.ts')).toBe('imported_open_module');
    expect(marked('test/uses-cycle.test.ts')).toBe('imported_open_module');
    expect(marked('test/passes-package-function.test.ts')).toBe('open_collection');
    expect(marked('test/passes-spread.test.ts')).toBe('open_collection');
    expect(marked('test/passes-inline.test.ts')).toBeUndefined();
    for (const name of ['conditional', 'and', 'nullish', 'comma', 'as', 'nonnull'])
      expect(marked(`test/passes-${name}.test.ts`), name).toBe('open_collection');
    expect(marked('test/passes-inline-choice.test.ts')).toBeUndefined();
    expect(marked('test/passes-returning.test.ts')).toBe('open_collection');
    expect(marked('test/uses-matchers-helper.test.ts')).toBe('imported_open_module');
    expect(marked('test/uses-plain-reflection.test.ts')).toBeUndefined();
    expect(marked('test/uses-plain-indexing.test.ts')).toBeUndefined();
    expect(marked('test/uses-builtin-loads.test.ts')).toBeUndefined();
    expect(marked('test/passes-returning-inline.test.ts')).toBeUndefined();
    // Calling a function that loads a package through createRequire may reach it.
    expect(marked('test/uses-created-require.test.ts')).toBe('open_collection');
    for (const name of ['name', 'runner', 'passed'])
      expect(marked(`test/uses-created-require-${name}.test.ts`), name).toBe('imported_open_module');
  });

  it('opens files that read properties which may run code at collection time', () => {
    const root = tempProject({
      'test/data.ts': "export const options = { rows: ['own'] } as const;\n",
      'test/getter-data.ts': "export const options = { get rows() { return ['own']; } };\n",
      'test/getter.test.ts':
        "import { it } from 'vitest';\nconst options = { get rows() { return ['own']; } };\nit.each(options.rows)('%s', () => {});\n",
      'test/static-getter.test.ts':
        "import { it } from 'vitest';\nclass Rows { static get all() { return ['own']; } }\nit.each(Rows.all)('%s', () => {});\n",
      'test/imported-getter.test.ts':
        "import { it } from 'vitest';\nimport { options } from './getter-data.js';\nit.each(options.rows)('%s', () => {});\n",
      'test/spread-import.test.ts':
        "import { it } from 'vitest';\nimport { options } from './getter-data.js';\nit.each([...options.rows])('%s', () => {});\n",
      'test/copy-import.test.ts':
        "import { it } from 'vitest';\nimport { options } from './getter-data.js';\nconst copied = { ...options };\nit('c', () => { copied; });\n",
      'test/destructure-import.test.ts':
        "import { it } from 'vitest';\nimport { options } from './getter-data.js';\nconst { rows } = options;\nit.each(rows)('%s', () => {});\n",
      'test/destructure-array-import.test.ts':
        "import { it } from 'vitest';\nimport { options } from './getter-data.js';\nconst [first] = options.rows;\nit('a', () => { first; });\n",
      'test/destructure-data.test.ts':
        "import { it } from 'vitest';\nimport { options } from './data.js';\nconst { rows } = options;\nconst [x] = [1];\nconst list = [1, 2];\nconst [y] = list;\nconst { a } = { a: 1 };\nit.each(rows)('%s', () => { x; y; a; });\n",
      'test/destructure-nested-import.test.ts':
        "import { it } from 'vitest';\nimport { options } from './getter-data.js';\nconst { nested: { rows } } = { nested: options };\nit.each(rows)('%s', () => {});\n",
      'test/destructure-nested-array-import.test.ts':
        "import { it } from 'vitest';\nimport { options } from './getter-data.js';\nconst [[first]] = [options.rows];\nit('a', () => { first; });\n",
      'test/destructure-nested-data.test.ts':
        "import { it } from 'vitest';\nconst local = { b: 2 };\nconst { nested: { a } } = { nested: { a: 1 } };\nconst [[x]] = [[1]];\nconst { inner: { b } } = { inner: local };\nit('n', () => { a; x; b; });\n",
      'test/plain-data.test.ts':
        "import { it } from 'vitest';\nimport { options } from './data.js';\nconst local = { rows: [1, 2] } as const;\nit.each(options.rows)('%s', () => {});\nit.each([...local.rows])('n %s', () => {});\n",
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const marked = (file: string) => inventory.files.find((f) => f.path === file)?.inexactNames;

    for (const file of [
      'getter',
      'static-getter',
      'imported-getter',
      'spread-import',
      'copy-import',
      'destructure-import',
      'destructure-array-import',
      'destructure-nested-import',
      'destructure-nested-array-import',
    ])
      expect(marked(`test/${file}.test.ts`), file).toBe('open_collection');
    expect(marked('test/plain-data.test.ts')).toBeUndefined();
    expect(marked('test/destructure-data.test.ts')).toBeUndefined();
    expect(marked('test/destructure-nested-data.test.ts')).toBeUndefined();
  });

  it('follows inline type-only imports, which a nearer tsconfig may keep, and erases only import type', () => {
    const files = {
      'test/shared-suite.ts':
        "import { it } from 'vitest';\nexport type Shared = number;\nexport function shared() { it('hidden', () => {}); }\n",
      'test/uses-type.test.ts':
        "import { it } from 'vitest';\nimport { type Shared } from './shared-suite.js';\nconst n: Shared = 1;\nit('t', () => { n; });\n",
      'test/uses-import-type.test.ts':
        "import { it } from 'vitest';\nimport type { Shared } from './shared-suite.js';\nconst n: Shared = 1;\nit('t', () => { n; });\n",
    };
    const marked = (extra: Record<string, string>, file = 'test/uses-type.test.ts') =>
      inventoryTests({
        recognition: vitest.recognition,
        root: tempProject({ ...files, ...extra }),
        config: VeritasConfig.parse({}),
      }).files.find((f) => f.path === file)?.inexactNames;

    // Whichever tsconfig the runner applies (the root one, a referenced one, a nearer one) may keep it.
    for (const tsconfig of <Record<string, string>[]>[
      {},
      { 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' },
      {
        'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
        'tsconfig.app.json': '{ "compilerOptions": { "verbatimModuleSyntax": true } }',
      },
    ])
      expect(marked(tsconfig)).toBe('imported_registrations');
    expect(marked({}, 'test/uses-import-type.test.ts')).toBeUndefined();
  });

  it('records Vitest options it could not read, on the test and inherited from a suite', () => {
    const root = tempProject({
      'test/unknown-options.test.ts': `
        import { describe, it } from 'vitest';
        const opts = { only: true };
        it.skip('named', opts, () => {});
        it.skip('spread', { ...opts }, () => {});
        it('spread then skip', { ...opts, skip: true }, () => {});
        describe.skip('D', opts, () => { it('inside', () => {}); });
        it('literal', { skip: true }, () => {});
        function check() {}
        it.only('by reference', check);
        it('reference after options', { only: true }, check);
        it('options before reference', opts, check);
        it('options after inline', () => {}, opts);
        it.only('reference with timeout', check, 1000);
      `,
    });
    const tests = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    }).tests;

    expect(tests.map((t) => [t.name, t.modifiers, t.optionsUnknown])).toEqual([
      ['named', ['skip'], true],
      ['spread', ['skip'], true],
      ['spread then skip', ['skip'], true],
      ['inside', ['skip'], true],
      ['literal', ['skip'], undefined],
      ['by reference', ['only'], undefined],
      ['reference after options', ['only'], undefined],
      ['options before reference', [], true],
      ['options after inline', [], true],
      ['reference with timeout', ['only'], undefined],
    ]);
  });

  it('reads Vitest test options that set a modifier, and takes other options as conditional', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/options.test.ts': `
        import { describe, it } from 'vitest';
        const opts = { only: true };
        it('focused', { only: true }, () => {});
        it('skipped', { skip: true, timeout: 10 }, () => {});
        it('failing', () => {}, { fails: true });
        it('unknown', opts, () => {});
        it('timed', () => {}, 1000);
        const base = { timeout: 1 };
        it('unskipped', { skip: true, ...{ skip: false } }, () => {});
        it('overridden', { skip: true, timeout: 5, skip: false }, () => {});
        it('skipped again', { ...base, skip: true }, () => {});
        it.only('unfocused', { only: false }, () => {});
        it.skip('unskipped chain', { skip: false }, () => {});
        it.fails('not failing', { fails: false }, () => {});
        describe.skip('skipped suite', () => { it('still skipped', { skip: false }, () => {}); });
        describe('suite', { concurrent: true }, () => { it('inside', () => {}); });
      `,
    });
    const tests = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    }).tests;

    expect(tests.map((t) => [t.name, t.modifiers, t.conditional])).toEqual([
      ['focused', ['only'], undefined],
      ['skipped', ['skip'], undefined],
      ['failing', ['expected_failure'], undefined],
      ['unknown', [], true],
      ['timed', [], undefined],
      ['unskipped', [], true],
      ['overridden', [], undefined],
      ['skipped again', ['skip'], true],
      ['unfocused', [], undefined],
      ['unskipped chain', [], undefined],
      ['not failing', [], undefined],
      ['still skipped', ['skip'], undefined],
      ['inside', ['concurrent'], undefined],
    ]);
  });

  it('records tests registered through a local module that hands out the runner API', () => {
    const root = tempProject({
      'test/fixtures.ts':
        "import { test as base } from 'vitest';\nexport const test = base.extend({ n: async ({}, use) => use(1) });\nexport { expect } from 'vitest';\n",
      'test/a.test.ts':
        "import { test, expect } from './fixtures.js';\nimport { describe } from 'vitest';\ndescribe('S', () => { test('uses fixture', () => { expect(1).toBe(1); }); });\ntest('top', () => {});\n",
      'test/wrap.ts': "import { it as vit } from 'vitest';\nexport const it = vit;\n",
      'test/b.test.ts': "import { it } from './wrap.js';\nit('wrapped', () => {});\n",
      'test/support.ts':
        "import { pkgRun } from 'external-test-package';\nexport function beforeEach(fn: () => void) { pkgRun(); fn(); }\n",
      'test/c.test.ts':
        "import { it } from 'vitest';\nimport { beforeEach } from './support.js';\nbeforeEach(() => {});\nit('c', () => {});\n",
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });
    const marked = (file: string) => inventory.files.find((f) => f.path === file)?.inexactNames;

    expect(inventory.tests.map((t) => [t.file, [...t.suitePath, t.name].join(' > ')])).toEqual([
      ['test/a.test.ts', 'S > uses fixture'],
      ['test/a.test.ts', 'top'],
      ['test/b.test.ts', 'wrapped'],
      ['test/c.test.ts', 'c'],
    ]);
    // The modules hand out the runner's API as a value, which is not followed: the files are not closed.
    expect(marked('test/a.test.ts')).toBe('imported_open_module');
    expect(marked('test/b.test.ts')).toBe('imported_open_module');
    // A support function with a hook's name is an ordinary function, which reaches a package.
    expect(marked('test/c.test.ts')).toBe('open_collection');
  });

  it('records registrations through aliases and namespace imports, and leaves the file closed', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/aliases.test.ts': `
        import { beforeEach as before, describe as d, expect, it, it as row, test as t } from 'vitest';
        import * as v from 'vitest';
        import { value } from '../src/value.js';
        before(() => { value(0); });
        it.each(['own'])('%s', (s) => { expect(s).toBe('own'); });
        row.each([1])('strong %s', (n) => { expect(value(n)).toBe(n); });
        t.skip('skipped', () => {});
        d('suite', () => { v.it.each([2])('ns %s', (n) => { expect(value(n)).toBe(n); }); });
        v.describe('ns suite', () => { v.test('inner', () => { expect(value(1)).toBe(1); }); });
      `,
      'test/extend.test.ts': `
        import { expect, it } from 'vitest';
        const myTest = it.extend({});
        myTest('hidden', () => { expect(1).toBe(1); });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(
      inventory.tests
        .filter((t) => t.file === 'test/aliases.test.ts')
        .map((t) => [[...t.suitePath, t.name].join(' > '), t.modifiers]),
    ).toEqual([
      ['%s', ['each']],
      ['strong %s', ['each']],
      ['skipped', ['skip']],
      ['suite > ns %s', ['each']],
      ['ns suite > inner', []],
    ]);
    expect(inventory.files.find((f) => f.path === 'test/aliases.test.ts')?.inexactNames).toBeUndefined();
    // A call of the runner's test API that is not a registration the inventory reads may register tests.
    expect(inventory.files.find((f) => f.path === 'test/extend.test.ts')?.inexactNames).toBe(
      'open_collection',
    );
  });

  it('records which titles of a table-driven test the runner formats', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/titles.test.ts': `
        import { describe, expect, it } from 'vitest';
        import { value } from '../src/value.js';
        describe('parse %s', () => {
          it.each([1])('value %d', (n) => expect(value(n)).toBe(n));
          describe.each([['a']])('mode %s', () => { it('plain %s', () => expect(value(1)).toBe(1)); });
          it('literal', () => expect(value(1)).toBe(1));
        });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.tableTitles])).toEqual([
      ['value %d', [1]],
      ['plain %s', [1]],
      ['literal', undefined],
    ]);
  });

  it('takes a table-driven registration whose table may be empty as conditional', () => {
    const root = tempProject({
      'test/tables.test.ts': [
        "import { describe, it } from 'vitest';",
        'const cases = [1];',
        "it.only.each([])('empty %s', () => {});",
        "it.each([1])('one %s', () => {});",
        "it.each(cases)('named %s', () => {});",
        "it.each([...cases])('spread %s', () => {});",
        `it.each\`\n  a\n  \${1}\n\`('tagged $a', () => {});`,
        "it.each`\n  a\n`('no rows $a', () => {});",
        "describe.only.each([])('suite %s', () => { it('inside', () => {}); });",
        "it.only.each([,])('holes %s', () => {});",
        "it.each([, 1])('hole then one %s', () => {});",
        '',
      ].join('\n'),
    });
    const tests = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    }).tests;

    expect(tests.map((t) => [t.name, t.conditional, t.emptyTable])).toEqual([
      ['empty %s', true, true],
      ['one %s', undefined, undefined],
      ['named %s', true, undefined],
      ['spread %s', true, undefined],
      ['tagged $a', undefined, undefined],
      ['no rows $a', true, true],
      ['inside', true, true],
      ['holes %s', true, true],
      ['hole then one %s', undefined, undefined],
    ]);
  });

  it('records tests registered on a condition', () => {
    const root = tempProject({
      'src/value.ts': 'export const value = (input: number) => input;\n',
      'test/conditional.test.ts': `
        import { describe, expect, it, test } from 'vitest';
        import { value } from '../src/value.js';
        it('always', () => expect(value(1)).toBe(1));
        if (process.env.CI) it('in ci', () => expect(value(1)).toBe(1));
        test.skipIf(true)('skip if', () => expect(value(1)).toBe(1));
        describe.runIf(true)('run if', () => { it('inside', () => expect(value(1)).toBe(1)); });
      `,
    });
    const inventory = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    });

    expect(inventory.tests.map((t) => [t.name, t.conditional])).toEqual([
      ['always', undefined],
      ['in ci', true],
      ['skip if', true],
      ['inside', true],
    ]);
  });
});
