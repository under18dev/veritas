import { stableId, VeritasConfig } from '@under18dev/veritas-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

function inventory(files: Record<string, string>) {
  return inventoryTests({
    recognition: vitest.recognition,
    root: tempProject(files),
    config: VeritasConfig.parse({}),
  });
}

function byName(result: ReturnType<typeof inventory>, name: string) {
  const test = result.tests.find((candidate) => candidate.name === name);

  if (!test) throw new Error(`missing test: ${name}`);

  return test;
}

const projectFn = 'export function projectFn(value: number): number { return value; }\n';

describe('locations use 1-based line numbers', () => {
  it('reports the test and its target calls on the lines they appear', () => {
    const result = inventory({
      'src/value.ts': projectFn,
      'test/lines.test.ts': [
        "import { expect, test } from 'vitest';",
        "import { projectFn } from '../src/value.js';",
        '',
        '// a comment line',
        "test('on line five', () => {",
        '  const value = 1;',
        '  expect(projectFn(value)).toBe(1);',
        '  expect(',
        '    projectFn(2),',
        '  ).toBe(2);',
        '});',
        '',
      ].join('\n'),
    });
    const test = byName(result, 'on line five');
    expect(test.location).toEqual({ file: 'test/lines.test.ts', range: { start: 5, end: 11 } });
    expect(test.targetCalls.map((call) => call.location)).toEqual([
      { file: 'test/lines.test.ts', range: { start: 7, end: 7 } },
      { file: 'test/lines.test.ts', range: { start: 9, end: 9 } },
    ]);
  });
});

describe('literal arguments', () => {
  it('treats negative, hex, and parenthesized numeric literals as literals', () => {
    const result = inventory({
      'src/value.ts': 'export function target(...values: unknown[]): number { return values.length; }\n',
      'test/args.test.ts': `
        import { expect, test } from 'vitest';
        import { target } from '../src/value.js';
        test('args', () => {
          const n = 3;
          expect(target(-1)).toBe(1);
          expect(target(-0x10, (5), (-2), +7, -1.5, 0x10, -n, 'x', -'y')).toBe(9);
          expect(target(1_000, \`plain\`, -10n)).toBe(3);
        });
      `,
    });
    expect(byName(result, 'args').targetCalls.map((call) => call.args)).toEqual([
      ['-1'],
      ['-16', '5', '-2', '7', '-1.5', '16', null, "'x'", null],
      ['1000', '`plain`', '-10n'],
    ]);
  });
});

describe('tautological_assertion requires compile-time constants on both sides', () => {
  const result = inventory({
    'src/value.ts': projectFn,
    'test/taut.test.ts': `
      import { expect, test } from 'vitest';
      import { projectFn } from '../src/value.js';
      import { readFileSync } from 'node:fs';
      const LIMIT = 10;
      const ALIAS = LIMIT;
      let mutable = 1;
      function check(input: number) { expect(input).toBe(1); }
      test('external value', () => {
        const actual = process.env.MODE;
        expect(actual).toBe('production');
      });
      test('non-project call', () => {
        expect(readFileSync('x', 'utf8')).toBe('x');
      });
      test('mutable variable', () => {
        mutable += 1;
        expect(mutable).toBe(2);
      });
      test('literal', () => expect(true).toBe(true));
      test('negative literal', () => expect(-1).toEqual((-1)));
      test('module constants', () => expect(LIMIT).toBe(ALIAS));
      test('local constants', () => {
        const a = 'x';
        const b = \`x\`;
        expect(a).toBe(b);
        expect([1, 2]).toEqual([1, 2]);
      });
      test('mixed', () => {
        expect(1).toBe(1);
        expect(projectFn(1)).toBe(1);
      });
      test('constant vs runtime', () => {
        expect(1).toBe(Number(process.env.X));
      });
      test('assertions count only', () => {
        expect.assertions(1);
        expect(process.env.X).toBeDefined();
      });
    `,
  });

  it.each([
    'external value',
    'non-project call',
    'mutable variable',
    'mixed',
    'constant vs runtime',
    'assertions count only',
  ])('%s is not tautological', (name) => {
    expect(byName(result, name).suspicions).not.toContain('tautological_assertion');
  });

  it.each(['literal', 'negative literal', 'module constants', 'local constants'])(
    '%s is tautological',
    (name) => {
      expect(byName(result, name).suspicions).toContain('tautological_assertion');
    },
  );
});

describe('mock detection is scoped to the test and to real Vitest mock APIs', () => {
  it('ignores mock-like methods on unrelated objects outside the test', () => {
    const result = inventory({
      'src/value.ts': projectFn,
      'test/mocks.test.ts': `
        import { expect, test } from 'vitest';
        import { projectFn } from '../src/value.js';
        test('real test', () => expect(projectFn(1)).toBe(1));
        const unrelated = { mockReturnValue() {} };
        unrelated.mockReturnValue(2);
      `,
    });
    const test = byName(result, 'real test');
    expect(test.usesMocks).toBe(false);
    expect(test.suspicions).not.toContain('unconditional_mock');
  });

  it('does not leak a mock in one test body to a sibling test', () => {
    const result = inventory({
      'src/value.ts': projectFn,
      'test/mocks.test.ts': `
        import { expect, test, vi } from 'vitest';
        import * as mod from '../src/value.js';
        test('mocking', () => {
          vi.spyOn(mod, 'projectFn').mockReturnValue(5);
          expect(mod.projectFn(1)).toBe(5);
        });
        test('clean', () => expect(mod.projectFn(1)).toBe(1));
      `,
    });
    expect(byName(result, 'mocking')).toMatchObject({ usesMocks: true });
    expect(byName(result, 'mocking').suspicions).toContain('unconditional_mock');
    expect(byName(result, 'clean').usesMocks).toBe(false);
    expect(byName(result, 'clean').suspicions).not.toContain('unconditional_mock');
  });

  it('applies module-level vi.mock to every test, flagging only when the mocked module exports the tested symbol', () => {
    const result = inventory({
      'src/value.ts': projectFn,
      'src/other.ts': 'export function other(): number { return 1; }\n',
      'test/a.test.ts': `
        import { expect, test, vi } from 'vitest';
        import { projectFn } from '../src/value.js';
        vi.mock('../src/other.js');
        test('dependency mocked', () => expect(projectFn(1)).toBe(1));
      `,
      'test/b.test.ts': `
        import { describe, expect, test, vi } from 'vitest';
        import { projectFn } from '../src/value.js';
        vi.mock('../src/value.js', () => ({ projectFn: vi.fn(() => 9) }));
        describe('suite', () => {
          test('target mocked', () => expect(projectFn(1)).toBe(9));
        });
      `,
    });
    const dependency = byName(result, 'dependency mocked');
    expect(dependency.usesMocks).toBe(true);
    expect(dependency.suspicions).not.toContain('unconditional_mock');
    const target = byName(result, 'target mocked');
    expect(target.usesMocks).toBe(true);
    expect(target.suspicions).toContain('unconditional_mock');
  });

  it('treats vi.fn and spies without mock implementations as mocks but not as mocking the target', () => {
    const result = inventory({
      'src/value.ts': projectFn,
      'src/other.ts': 'export function other(): number { return 1; }\n',
      'test/c.test.ts': `
        import { expect, test, vi } from 'vitest';
        import { projectFn } from '../src/value.js';
        import * as other from '../src/other.js';
        import * as value from '../src/value.js';
        test('vi.fn', () => { const cb = vi.fn(); cb(); expect(projectFn(1)).toBe(1); });
        test('spy only', () => { vi.spyOn(value, 'projectFn'); expect(projectFn(1)).toBe(1); });
        test('other spy mocked', () => {
          vi.spyOn(other, 'other').mockReturnValue(3);
          expect(projectFn(1)).toBe(1);
        });
        test('spy variable', () => {
          const spy = vi.spyOn(value, 'projectFn');
          spy.mockImplementation(() => 4);
          expect(projectFn(1)).toBe(4);
        });
        test('vi.mocked', () => {
          vi.mocked(projectFn).mockReturnValue(4);
          expect(projectFn(1)).toBe(4);
        });
      `,
    });

    for (const name of ['vi.fn', 'spy only', 'other spy mocked']) {
      expect(byName(result, name).usesMocks).toBe(true);
      expect(byName(result, name).suspicions).not.toContain('unconditional_mock');
    }

    for (const name of ['spy variable', 'vi.mocked']) {
      expect(byName(result, name).usesMocks).toBe(true);
      expect(byName(result, name).suspicions).toContain('unconditional_mock');
    }
  });

  it('applies mocks from enclosing describe hooks but not from sibling describes', () => {
    const result = inventory({
      'src/value.ts': projectFn,
      'test/d.test.ts': `
        import { beforeEach, describe, expect, test, vi } from 'vitest';
        import * as value from '../src/value.js';
        describe('mocked', () => {
          beforeEach(() => { vi.spyOn(value, 'projectFn').mockReturnValue(7); });
          test('inside', () => expect(value.projectFn(1)).toBe(7));
        });
        describe('plain', () => {
          test('outside', () => expect(value.projectFn(1)).toBe(1));
        });
      `,
    });
    expect(byName(result, 'inside').suspicions).toContain('unconditional_mock');
    expect(byName(result, 'outside').usesMocks).toBe(false);
  });
});

describe('registration functions taken from a namespace import of the runner', () => {
  it('inventories tests registered through a constant bound to a member of the namespace', () => {
    const result = inventory({
      'test/namespace.test.ts': [
        "import * as v from 'vitest';",
        'const test = v.test;',
        'const fixture = v.test.extend({});',
        "const named = v['it'];",
        "test('works', () => { v.expect(1).toBe(1); });",
        "test.skip('skipped', () => {});",
        "test.each([1, 2])('row %s', (n) => { v.expect(n).toBeGreaterThan(0); });",
        "fixture('with fixtures', () => {});",
        "named('by a literal key', () => {});",
        '',
      ].join('\n'),
    });

    expect(byName(result, 'works').modifiers).toEqual([]);
    expect(byName(result, 'skipped').modifiers).toEqual(['skip']);
    expect(byName(result, 'row %s').modifiers).toContain('each');
    expect(byName(result, 'with fixtures')).toBeDefined();
    expect(byName(result, 'by a literal key')).toBeDefined();
  });

  it('keeps the suite path of tests in a suite destructured from the namespace', () => {
    const file = 'test/destructured.test.ts';
    const result = inventory({
      [file]: [
        "import * as v from 'vitest';",
        'const test = v.test;',
        'const { describe } = v;',
        'const { it: check } = v;',
        'const ns = v;',
        "const { 'test': quoted } = ns;",
        "describe('D', () => {",
        "  test('ns const', () => {});",
        "  check('ns destructured', () => {});",
        "  quoted('through an alias', () => {});",
        '});',
        '',
      ].join('\n'),
    });

    for (const name of ['ns const', 'ns destructured', 'through an alias']) {
      const test = byName(result, name);
      expect(test.suitePath, name).toEqual(['D']);
      // The id main gives the test: from its file, suite path and title.
      expect(test.id, name).toBe(stableId('T', { file, suitePath: ['D'], name }));
    }
  });
});

describe('suites whose title is not a literal', () => {
  it('pass their modifiers on to what they register, but not each', () => {
    const result = inventory({
      'test/dynamic-suites.test.ts': [
        "import { describe, it } from 'vitest';",
        "const title = ['a', 'b'].join(' ');",
        "describe.skip(title, () => { it('hidden', () => {}); });",
        "describe.only(title, () => { it('focused', () => {}); });",
        "describe.each([1])(title, () => { it('row', () => {}); });",
        '',
      ].join('\n'),
    });

    expect(byName(result, 'hidden').modifiers).toContain('skip');
    expect(byName(result, 'hidden').inexactName).toBe('dynamic_suite');
    expect(byName(result, 'focused').modifiers).toContain('only');
    expect(byName(result, 'row').modifiers).not.toContain('each');
  });
});

describe('constants bound to a registration function with modifiers', () => {
  it('inventories the tests they register, with those modifiers', () => {
    const file = 'test/modified.test.ts';
    const result = inventory({
      [file]: [
        "import * as v from 'vitest';",
        "import { describe, it, test } from 'vitest';",
        'const concurrent = it.concurrent;',
        'const skipped = test.skip;',
        'const focused = v.test.only;',
        'const failing = it.fails;',
        'const later = describe.skip;',
        'const table = it.each;',
        "concurrent('works', () => {});",
        "skipped('skipped', () => {});",
        "focused('focused', () => {});",
        "failing('fails', () => {});",
        "concurrent.skip('both', () => {});",
        "later('S', () => { it('inside', () => {}); });",
        "table([1])('row %s', () => {});",
        '',
      ].join('\n'),
    });

    expect(byName(result, 'works').modifiers).toEqual(['concurrent']);
    expect(byName(result, 'works').id).toBe(stableId('T', { file, suitePath: [], name: 'works' }));
    expect(byName(result, 'skipped').modifiers).toEqual(['skip']);
    expect(byName(result, 'focused').modifiers).toEqual(['only']);
    expect(byName(result, 'fails').modifiers).toContain('expected_failure');
    expect(byName(result, 'both').modifiers).toEqual(expect.arrayContaining(['concurrent', 'skip']));
    expect(byName(result, 'inside').suitePath).toEqual(['S']);
    expect(byName(result, 'inside').modifiers).toContain('skip');
    // A factory bound to a constant is not read, as before.
    expect(result.tests.some((test) => test.name === 'row %s')).toBe(false);

    // Under the name of the runner's export, as main read it.
    const named = inventory({
      'test/named.test.ts':
        "import { it } from 'vitest';\nconst test = it.concurrent;\ntest('works', () => {});\n",
    });
    expect(byName(named, 'works').modifiers).toEqual(['concurrent']);
  });
});

describe('tagged template tables', () => {
  it('records which formatted titles take their rows from a tagged template', () => {
    const result = inventory({
      'test/tagged.test.ts': [
        "import { describe, it } from 'vitest';",
        "describe.each([1])('suite %s', () => {",
        `  it.each\`a\n$\{1}\`('100%% $a', () => {});`,
        "  it.each([2])('row %s', () => {});",
        '});',
        '',
      ].join('\n'),
    });

    expect(byName(result, '100%% $a').tableTitles).toEqual([0, 1]);
    expect(byName(result, '100%% $a').templateTableTitles).toEqual([1]);
    expect(byName(result, 'row %s').tableTitles).toEqual([0, 1]);
    expect(byName(result, 'row %s').templateTableTitles).toBeUndefined();
  });
});

describe('Vitest options of suites and tests', () => {
  it('reads them as Vitest 5 runs them: a skipped or todo suite holds every test in it, its own options aside', () => {
    // Run with Vitest 5.1.1: `works`, `deep` and `c` are skipped, `t` is a todo, and `chain then option` runs (a
    // test's own option overrides its chain, while a suite's mode skips all it holds).
    const result = inventory({
      'test/options.test.ts': [
        "import { describe, it } from 'vitest';",
        "describe('suite', { skip: true }, () => {",
        "  it('works', { skip: false }, () => {});",
        "  describe('inner', { skip: false }, () => { it('deep', () => {}); });",
        '});',
        "it.skip('chain then option', { skip: false }, () => {});",
        "describe.skip('chained', () => { it('c', { skip: false }, () => {}); });",
        "describe('todo', { todo: true }, () => { it('t', { todo: false }, () => {}); });",
        '',
      ].join('\n'),
    });

    expect(byName(result, 'works').modifiers).toContain('skip');
    expect(byName(result, 'deep').modifiers).toContain('skip');
    expect(byName(result, 'chain then option').modifiers).not.toContain('skip');
    expect(byName(result, 'c').modifiers).toContain('skip');
    expect(byName(result, 't').modifiers).toContain('todo');
  });
});
