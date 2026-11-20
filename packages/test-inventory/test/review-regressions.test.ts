import { VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

function inventory(files: Record<string, string>) {
  return inventoryTests({ root: tempProject(files), config: VeritasConfig.parse({}) });
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
