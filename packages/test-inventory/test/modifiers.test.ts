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
      "import { beforeEach, describe, expect, it, vi } from 'vitest';",
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
      mockBracket: "vi['mock']('../src/value.js', () => { sharedSuite(); return {}; });",
      mockComputedKey: "const key = 'mock'; vi[key]('../src/value.js', () => ({}));",
      mockByReference:
        "const factory = () => { sharedSuite(); return {}; }; vi.mock('../src/value.js', factory);",
      hoistedByReference: 'const h = vi.hoisted(helpers.run);',
      hookArgument: 'beforeEach(sharedSuite());',
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
    };
    for (const [name, code] of Object.entries(open))
      files[`test/open-${name}.test.ts`] = `${header}\n${code}\n`;
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

    for (const name of Object.keys(open))
      expect(marked(`test/open-${name}.test.ts`), name).toBe('open_collection');
    for (const name of Object.keys(closed))
      expect(marked(`test/closed-${name}.test.ts`), name).toBeUndefined();
    // Importing a module that registers tests is enough: its tests run under this file.
    expect(marked('test/imports-registering.test.ts')).toBe('imported_registrations');
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
