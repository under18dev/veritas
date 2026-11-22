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
    ])
      expect(marked(`test/${file}.test.ts`), file).toBe('open_collection');
    expect(marked('test/plain-data.test.ts')).toBeUndefined();
    expect(marked('test/destructure-data.test.ts')).toBeUndefined();
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
      ['inside', ['concurrent'], undefined],
    ]);
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
