import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Mutant, stableId } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { importMutationReport, mutatorTestId, mutatorTestRef, shellQuote } from '../src/index.js';
import { tempDir } from './helpers.js';

const SOURCE =
  'export function f(a: number): number {\n  if (a > 10) {\n    return a + 1;\n  }\n  return 0;\n}\n';

const loc = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, column: sc },
  end: { line: el, column: ec },
});

function mutant(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    mutatorName: 'EqualityOperator',
    replacement: 'a >= 10',
    location: loc(2, 7, 2, 13),
    status,
    killedBy: [],
    coveredBy: [],
    ...extra,
  };
}

function report(mutants: unknown[], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: '2',
    thresholds: { high: 80, low: 60 },
    files: { 'src/f.ts': { language: 'typescript', source: SOURCE, mutants } },
    ...extra,
  };
}

const root = tempDir('import');

describe('importMutationReport: status mapping', () => {
  const cases: [string, string][] = [
    ['Killed', 'killed'],
    ['Survived', 'survived'],
    ['NoCoverage', 'no_coverage'],
    ['Timeout', 'timeout'],
    ['CompileError', 'compile_error'],
    ['RuntimeError', 'runtime_error'],
    ['Ignored', 'ignored'],
    ['Pending', 'pending'],
  ];
  it.each(cases)('maps %s to %s', (raw, expected) => {
    const [m] = importMutationReport(report([mutant('k1', raw)]), { root, source: 'mutator' });
    expect(m?.status).toBe(expected);
    expect(() => Mutant.parse(m)).not.toThrow();
  });

  it('maps unrecognized statuses to unknown and records the raw status', () => {
    const [m] = importMutationReport(report([mutant('k1', 'Equivalent', { statusReason: 'tool says so' })]), {
      root,
      source: 'mutator',
    });
    expect(m?.status).toBe('unknown');
    expect(m?.statusReason).toBe('unrecognized backend status: Equivalent; tool says so');
  });

  it('does not treat inherited object keys as statuses', () => {
    const [m] = importMutationReport(report([mutant('k1', 'constructor')]), { root, source: 'mutator' });
    expect(m?.status).toBe('unknown');
  });

  it('keeps the reason of ignored mutants (accepted equivalents, arid code)', () => {
    const mutants = importMutationReport(
      report([
        mutant('a', 'Ignored', { statusReason: 'accepted: value is never nullish' }),
        mutant('b', 'Ignored', { statusReason: 'arid: console.log' }),
      ]),
      { root, source: 'mutator' },
    );
    expect(mutants.map((m) => [m.status, m.statusReason])).toEqual([
      ['ignored', 'accepted: value is never nullish'],
      ['ignored', 'arid: console.log'],
    ]);
  });

  it('never infers equivalence: a survivor stays survived', () => {
    const mutants = importMutationReport(
      report([
        mutant('s', 'Survived', {
          statusReason: 'not infected: no covering test reaches it with a value it changes',
        }),
      ]),
      { root, source: 'mutator' },
    );
    expect(mutants[0]?.status).toBe('survived');

    for (const m of mutants) expect(['equivalent_proven', 'suspected_equivalent']).not.toContain(m.status);
  });

  it('records child-process mutants as unknown with their reason, not as survivors', () => {
    const reason =
      'possibly reached in a child process: a test runs the file in a child process, where mutator cannot observe mutants';
    const mutants = importMutationReport(
      report([
        mutant('c1', 'Survived', { statusReason: reason }),
        mutant('c2', 'NoCoverage'),
        mutant('c3', 'Killed'),
      ]),
      { root, source: 'mutator', childProcessKeys: new Set(['c2', 'c3']) },
    );
    expect(mutants.map((m) => m.status)).toEqual(['unknown', 'unknown', 'killed']);
    expect(mutants[0]?.statusReason).toBe(reason);
    expect(mutants[1]?.statusReason).toContain('possibly reached in a child process');
  });
});

describe('importMutationReport: mutant fields', () => {
  it('fills location, operator, original/replacement, tests and reproduction', () => {
    const [m] = importMutationReport(
      report([
        mutant('e5rgni1gq2', 'Killed', {
          killedBy: ['test/f.test.ts#suite > case'],
          coveredBy: ['test/f.test.ts#suite > case', 'test/f.test.ts#other'],
        }),
      ]),
      { root, source: 'mutator' },
    );
    expect(m).toMatchObject({
      id: stableId('M', { file: 'src/f.ts', key: 'e5rgni1gq2' }),
      backendKey: 'e5rgni1gq2',
      location: { file: 'src/f.ts', range: { start: 2, end: 2 } },
      operator: 'EqualityOperator',
      original: 'a > 10',
      replacement: 'a >= 10',
      relevance: 'unknown',
      propertyIds: [],
      reproduction: `mutator --root ${shellQuote(root)} --only e5rgni1gq2`,
    });
    expect(m?.killedBy).toEqual([
      stableId('T', { file: 'test/f.test.ts', suitePath: ['suite'], name: 'case' }),
    ]);
    expect(m?.coveredBy).toEqual([
      stableId('T', { file: 'test/f.test.ts', suitePath: ['suite'], name: 'case' }),
      stableId('T', { file: 'test/f.test.ts', suitePath: [], name: 'other' }),
    ]);
  });

  it('slices multi-line originals and uses the line range', () => {
    const [m] = importMutationReport(report([mutant('k', 'Killed', { location: loc(2, 15, 4, 4) })]), {
      root,
      source: 'mutator',
    });
    expect(m?.original).toBe('{\n    return a + 1;\n  }');
    expect(m?.location.range).toEqual({ start: 2, end: 4 });
  });

  it('leaves original empty rather than guessing when the report has no source', () => {
    const json = { schemaVersion: '2', files: { 'src/f.ts': { mutants: [mutant('k', 'Killed')] } } };
    expect(importMutationReport(json, { root, source: 'mutator' })[0]?.original).toBe('');
  });

  it('gives the same id across imports and different ids per key and file', () => {
    const a = importMutationReport(report([mutant('k1', 'Killed'), mutant('k2', 'Killed')]), {
      root,
      source: 'mutator',
    });
    const b = importMutationReport(report([mutant('k1', 'Survived')]), { root, source: 'mutator' });
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[0]?.id).not.toBe(a[1]?.id);
  });

  it('quotes roots with spaces in the reproduction command', () => {
    const spaced = path.join(tempDir('import'), 'my project');
    mkdirSync(spaced);
    const [m] = importMutationReport(report([mutant('k1', 'Killed')]), { root: spaced, source: 'mutator' });
    expect(m?.reproduction).toBe(`mutator --root ${shellQuote(spaced)} --only k1`);
    expect(m?.reproduction).toContain(`'${spaced}'`);
  });
});

describe('importMutationReport: Stryker and generic reports', () => {
  const stryker = {
    schemaVersion: '2.0',
    thresholds: { high: 80, low: 60 },
    framework: { name: 'StrykerJS', version: '9.0.0' },
    files: {
      'src/f.ts': {
        language: 'typescript',
        source: SOURCE,
        mutants: [
          {
            id: '0',
            mutatorName: 'ConditionalExpression',
            replacement: 'true',
            location: loc(2, 7, 2, 13),
            status: 'Killed',
            killedBy: ['t1'],
            coveredBy: ['t1', 't2'],
            duration: 12,
          },
          {
            id: '1',
            mutatorName: 'ArithmeticOperator',
            replacement: 'a - 1',
            location: loc(3, 12, 3, 17),
            status: 'Survived',
            coveredBy: ['t2', 'unlisted'],
          },
          { id: '2', mutatorName: 'BlockStatement', location: loc(5, 3, 5, 12), status: 'NoCoverage' },
        ],
      },
    },
    testFiles: {
      'test/f.spec.ts': {
        tests: [
          { id: 't1', name: 'f returns a+1 above 10' },
          { id: 't2', name: 'f returns 0 otherwise' },
        ],
      },
    },
  };

  it('maps a Stryker report, keeping raw test refs where the suite path is unknown', () => {
    const mutants = importMutationReport(stryker, { root, source: 'stryker' });
    expect(mutants.map((m) => m.status)).toEqual(['killed', 'survived', 'no_coverage']);
    expect(mutants[0]).toMatchObject({
      original: 'a > 10',
      replacement: 'true',
      durationMs: 12,
      killedBy: ['test/f.spec.ts#f returns a+1 above 10'],
      coveredBy: ['test/f.spec.ts#f returns a+1 above 10', 'test/f.spec.ts#f returns 0 otherwise'],
      reproduction: 'npx stryker run --mutate src/f.ts:2:7-2:13',
    });
    expect(mutants[1]?.original).toBe('a + 1');
    expect(mutants[1]?.coveredBy).toEqual(['test/f.spec.ts#f returns 0 otherwise', 'unlisted']);
    expect(mutants[2]?.replacement).toBe('');
  });

  it('states that reproduction is unavailable for an unidentified backend', () => {
    const [m] = importMutationReport(stryker, { root, source: 'mutation-testing-elements' });
    expect(m?.reproduction).toMatch(/^unavailable: /);
  });

  it('rejects reports that are not mutation-testing-elements schemaVersion 2', () => {
    expect(() =>
      importMutationReport({ ...stryker, schemaVersion: '1' }, { root, source: 'stryker' }),
    ).toThrow(/schemaVersion 2/);
    expect(() => importMutationReport(null, { root, source: 'mutator' })).toThrow(/not a mutation-testing/);
    expect(() =>
      importMutationReport(report([{ id: 'x', status: 'Killed' }]), { root, source: 'mutator' }),
    ).toThrow(/not a mutation-testing/);
  });
});

describe('importMutationReport: paths', () => {
  it('rejects file keys that escape the project root', () => {
    for (const key of ['../outside.ts', '/etc/passwd', 'src/../../x.ts']) {
      const json = { schemaVersion: '2', files: { [key]: { mutants: [mutant('k', 'Killed')] } } };
      expect(() => importMutationReport(json, { root, source: 'mutator' })).toThrow(
        /escapes the project root/,
      );
    }
  });

  it('relativizes absolute paths inside the root to posix form', () => {
    const json = {
      schemaVersion: '2',
      files: { [path.join(root, 'src', 'f.ts')]: { mutants: [mutant('k', 'Killed')] } },
    };
    expect(importMutationReport(json, { root, source: 'mutator' })[0]?.location.file).toBe('src/f.ts');
  });
});

describe('mutatorTestRef', () => {
  it('splits file, suite path and name from a vitest full name', () => {
    expect(mutatorTestRef('test/a.test.ts#outer > inner > does it')).toEqual({
      file: 'test/a.test.ts',
      suitePath: ['outer', 'inner'],
      name: 'does it',
    });
    expect(mutatorTestRef('test/a.test.ts#top level')).toEqual({
      file: 'test/a.test.ts',
      suitePath: [],
      name: 'top level',
    });
  });

  it('drops a multi-project prefix and keeps later # characters in the name', () => {
    expect(mutatorTestRef('test/a.test.ts#[unit] suite > handles #1')).toEqual({
      file: 'test/a.test.ts',
      suitePath: ['suite'],
      name: 'handles #1',
    });
  });

  it('handles names without a file part', () => {
    expect(mutatorTestRef('lonely')).toEqual({ file: '', suitePath: [], name: 'lonely' });
  });

  it('derives test ids with the test-inventory scheme', () => {
    expect(mutatorTestId('test/a.test.ts#s > n')).toBe(
      stableId('T', { file: 'test/a.test.ts', suitePath: ['s'], name: 'n' }),
    );
  });
});
