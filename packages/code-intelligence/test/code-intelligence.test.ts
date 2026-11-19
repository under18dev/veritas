import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, sha256, type VeritasConfigInput, VeritasError } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  analyzeCode,
  BehaviorCandidate,
  CodeIndex,
  type FunctionInfo,
  inferBehaviorCandidates,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function copyFixture(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-ci-${name}-`)));
  cpSync(path.join(REPO_ROOT, 'fixtures', name), dir, { recursive: true });
  return dir;
}

function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-ci-')));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const config = (input: VeritasConfigInput = {}) => parseConfig(input, null);

function analyze(root: string, files?: string[], input?: VeritasConfigInput) {
  const index = analyzeCode({ root, config: config(input), ...(files ? { files } : {}) });
  // Every result must satisfy the exported schema.
  expect(CodeIndex.parse(index)).toEqual(index);
  return index;
}

function fn(index: CodeIndex, symbol: string): FunctionInfo {
  const found = index.functions.find((f) => f.symbol === symbol);
  if (!found)
    throw new Error(`no function ${symbol}; have ${index.functions.map((f) => f.symbol).join(', ')}`);
  return found;
}

const reasons = (f: FunctionInfo) => f.unsupported.map((u) => u.reason);

describe('discount-boundary fixture', () => {
  const root = copyFixture('discount-boundary');
  const index = analyze(root);

  it('analyzes only source files, never tests or candidates outside include', () => {
    expect(index.files.map((f) => f.path)).toEqual(['src/pricing.ts']);
    expect(index.functions.every((f) => !f.file.startsWith('test/'))).toBe(true);
  });

  it('hashes file contents with sha256', () => {
    expect(index.files[0]?.hash).toBe(sha256(readFileSync(path.join(root, 'src/pricing.ts'), 'utf8')));
  });

  it('finds the total > 1000 comparison at line 3 in a pure function', () => {
    const f = fn(index, 'src/pricing.ts#discountAmount');
    expect(f.exported).toBe(true);
    expect(f.purity).toBe('pure');
    expect(f.location).toEqual({ file: 'src/pricing.ts', range: { start: 2, end: 7 } });
    expect(f.params).toEqual([{ name: 'total', type: 'number', optional: false }]);
    expect(f.returnType).toBe('number');
    expect(f.jsdoc).toBe('Flat discount applied at checkout.');
    expect(f.comparisons).toEqual([
      {
        location: { file: 'src/pricing.ts', range: { start: 3, end: 3 } },
        operator: '>',
        left: 'total',
        right: '1000',
        literal: '1000',
        param: 'total',
      },
    ]);
    expect(f.branches).toEqual([
      { location: { file: 'src/pricing.ts', range: { start: 3, end: 5 } }, condition: 'total > 1000' },
    ]);
    expect(f.returns.map((r) => [r.location.range?.start, r.expression])).toEqual([
      [4, '100'],
      [6, '0'],
    ]);
    expect(f.unsupported).toEqual([]);
    expect(f.numericKinds).toEqual(['integer_literal']);
  });

  it('proposes boundary 1000 with operator > as an inferred candidate', () => {
    const candidates = inferBehaviorCandidates(index);
    const boundary = candidates.filter(
      (c) => c.symbol === 'src/pricing.ts#discountAmount' && c.boundary !== undefined,
    );
    expect(boundary).toHaveLength(1);
    expect(boundary[0]).toMatchObject({
      template: 'boundary',
      boundary: { param: 'total', operator: '>', value: '1000' },
      origin: 'inferred',
      basis: ['implementation'],
    });
    for (const c of candidates) expect(BehaviorCandidate.parse(c)).toEqual(c);
  });
});

describe('no-spec fixture', () => {
  it('keeps every candidate for process inferred', () => {
    const root = copyFixture('no-spec');
    const index = analyze(root);
    const f = fn(index, 'src/calc.ts#process');
    expect(f.comparisons[0]).toMatchObject({
      operator: '>',
      left: 'a',
      right: 'b',
      literal: null,
      param: 'a',
    });
    const candidates = inferBehaviorCandidates(index).filter((c) => c.symbol === 'src/calc.ts#process');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.origin === 'inferred')).toBe(true);
    expect(candidates.every((c) => c.notes.some((n) => n.includes('not a specification')))).toBe(true);
  });
});

describe('function facts', () => {
  const root = project({
    'src/shapes.ts': `import { helper } from './util';
import { external } from 'some-missing-package';

/**
 * Classify a score.
 * @throws RangeError when negative
 */
export function grade(score: number, label?: string, tags: string[] = []): string {
  if (score < 0) {
    throw new RangeError('negative');
  }
  switch (label) {
    case 'x':
      return 'X';
    default:
      break;
  }
  return score >= 0x10 ? helper(score) : 'low';
}

export const double = (n: number): number => n * 2;

function hidden(n: number): number {
  return -5 <= n ? 1_000 : n;
}

export { hidden as visible };

export class Calc {
  add(a: number, b: number): number {
    return a + b;
  }
}

export function usesExternal(x: number): number {
  return external(x);
}

export function callsBack(cb: (n: number) => number): number {
  return cb(1);
}

export function usesLocalHelper(n: number): number {
  const inc = (k: number) => k + 1;
  return inc(n);
}

export async function later(n: number): Promise<number> {
  return await Promise.resolve(n);
}
`,
    'src/util.ts': `export function helper(n: number): string {
  return n > 100 ? 'high' : 'mid';
}
`,
  });
  const index = analyze(root);

  it('records params, optionality, return type, jsdoc and location', () => {
    const f = fn(index, 'src/shapes.ts#grade');
    expect(f.name).toBe('grade');
    expect(f.params).toEqual([
      { name: 'score', type: 'number', optional: false },
      { name: 'label', type: 'string | undefined', optional: true },
      { name: 'tags', type: 'string[]', optional: true },
    ]);
    expect(f.returnType).toBe('string');
    expect(f.jsdoc).toBe('Classify a score.\n@throws RangeError when negative');
    expect(f.async).toBe(false);
    expect(f.location.range).toEqual({ start: 8, end: 19 });
  });

  it('records if, switch and ternary branches, returns and throws', () => {
    const f = fn(index, 'src/shapes.ts#grade');
    expect(f.branches.map((b) => b.condition)).toEqual([
      'score < 0',
      "label === 'x'",
      'default',
      'score >= 0x10',
    ]);
    expect(f.throws).toEqual([
      {
        location: { file: 'src/shapes.ts', range: { start: 10, end: 10 } },
        expression: "new RangeError('negative')",
      },
    ]);
    expect(f.returns.map((r) => r.expression)).toEqual(["'X'", "score >= 0x10 ? helper(score) : 'low'"]);
  });

  it('normalizes integer literals to decimal and identifies the compared parameter', () => {
    const f = fn(index, 'src/shapes.ts#grade');
    expect(f.comparisons.map((c) => [c.operator, c.literal, c.param])).toEqual([
      ['<', '0', 'score'],
      ['>=', '16', 'score'],
    ]);
    const hidden = fn(index, 'src/shapes.ts#visible');
    expect(hidden.comparisons[0]).toMatchObject({
      operator: '<=',
      left: '-5',
      right: 'n',
      literal: '-5',
      param: 'n',
    });
  });

  it('resolves in-project calls to symbol ids and keeps external callee text', () => {
    expect(fn(index, 'src/shapes.ts#grade').calls).toEqual(['src/util.ts#helper']);
    expect(fn(index, 'src/shapes.ts#usesExternal').calls).toEqual(['external']);
  });

  it('names arrow functions, class methods and aliased exports', () => {
    expect(fn(index, 'src/shapes.ts#double')).toMatchObject({
      exported: true,
      returns: [{ expression: 'n * 2' }],
    });
    expect(fn(index, 'src/shapes.ts#Calc.add')).toMatchObject({ name: 'Calc.add', exported: true });
    expect(fn(index, 'src/shapes.ts#visible')).toMatchObject({ name: 'hidden', exported: true });
  });

  it('marks exported false for non-exported functions', () => {
    const local = project({ 'src/a.ts': 'function inner(n: number) { return n; }\nexport const x = 1;\n' });
    expect(fn(analyze(local), 'src/a.ts#inner').exported).toBe(false);
  });

  it('classifies purity: pure, unknown for unresolved or callback callees, pure for local helpers', () => {
    expect(fn(index, 'src/shapes.ts#grade').purity).toBe('pure');
    expect(fn(index, 'src/util.ts#helper').purity).toBe('pure');
    expect(fn(index, 'src/shapes.ts#usesExternal').purity).toBe('unknown');
    expect(fn(index, 'src/shapes.ts#callsBack').purity).toBe('unknown');
    expect(fn(index, 'src/shapes.ts#usesLocalHelper').purity).toBe('pure');
  });

  it('flags async functions and await', () => {
    const f = fn(index, 'src/shapes.ts#later');
    expect(f.async).toBe(true);
    expect(reasons(f)).toEqual(expect.arrayContaining(['async function', 'await']));
  });

  it('produces posix symbol ids and identical results on repeated runs', () => {
    const again = analyze(root);
    expect(again).toEqual(index);
    expect(inferBehaviorCandidates(again)).toEqual(inferBehaviorCandidates(index));
    for (const f of index.functions) {
      expect(f.symbol).not.toContain('\\');
      expect(f.symbol.startsWith(`${f.file}#`)).toBe(true);
    }
  });

  it('accepts explicit files with Windows separators and keeps ids posix', () => {
    const explicit = analyze(root, ['src\\util.ts']);
    expect(explicit.files.map((f) => f.path)).toEqual(['src/util.ts']);
    expect(explicit.functions.map((f) => f.symbol)).toEqual(['src/util.ts#helper']);
  });
});

describe('unsupported constructs are listed, never dropped', () => {
  const root = project({
    'src/bad.ts': `export function useEval(code: string): unknown {
  return eval(code);
}
export function useFunction(body: string): unknown {
  return new Function(body);
}
export function useProxy(target: object): object {
  return new Proxy(target, {});
}
export function dynamicKey(obj: Record<string, number>, key: string): number | undefined {
  return obj[key];
}
export function* gen(): Generator<number> {
  yield 1;
}
export function floats(x: number): number {
  return x * 0.5;
}
export function divide(a: number, b: number): number {
  return a / b + (a % b);
}
export function nan(x: number): boolean {
  return x === NaN || x === Infinity || x === Number.POSITIVE_INFINITY;
}
export function coerce(s: string, n: number): boolean {
  return +s === n || (s as string | number) == n;
}
export function concat(s: string, n: number): string {
  return s + n;
}
export function big(n: bigint): bigint {
  return n + 10n;
}
export function rounding(n: number): number {
  return Math.floor(n);
}
export class Box {
  value = 1;
  get current(): number {
    return this.value;
  }
  set current(v: number) {
    this.value = v;
  }
}
`,
    'src/legacy.js': `function legacy(obj) {
  with (obj) {
    return a;
  }
}
`,
  });
  const index = analyze(root);
  const r = (symbol: string) => reasons(fn(index, symbol));

  it.each([
    ['src/bad.ts#useEval', 'eval'],
    ['src/bad.ts#useFunction', 'Function constructor'],
    ['src/bad.ts#useProxy', 'Proxy'],
    ['src/bad.ts#dynamicKey', 'computed property access on parameter obj'],
    ['src/bad.ts#gen', 'generator function'],
    ['src/bad.ts#gen', 'yield'],
    ['src/bad.ts#floats', 'floating-point literal 0.5'],
    ['src/bad.ts#divide', '/ operator'],
    ['src/bad.ts#divide', '% operator'],
    ['src/bad.ts#nan', 'NaN'],
    ['src/bad.ts#nan', 'Infinity'],
    ['src/bad.ts#nan', 'Number.POSITIVE_INFINITY'],
    ['src/bad.ts#coerce', 'implicit coercion: unary + on a non-number'],
    ['src/bad.ts#coerce', 'implicit coercion: == between different or unknown types'],
    ['src/bad.ts#concat', 'implicit coercion: + on mixed or non-numeric operands'],
    ['src/bad.ts#big', 'bigint literal 10n'],
    ['src/bad.ts#rounding', 'Math.floor is outside the integer model'],
    ['src/bad.ts#Box.current', 'getter accessor'],
    ['src/bad.ts#Box.current', 'this'],
    ['src/bad.ts#Box.current=', 'setter accessor'],
    ['src/legacy.js#legacy', 'with statement'],
  ])('%s lists %s', (symbol, reason) => {
    expect(r(symbol)).toContain(reason);
  });

  it('records source locations for unsupported constructs', () => {
    const f = fn(index, 'src/bad.ts#divide');
    expect(
      f.unsupported.every((u) => u.location.file === 'src/bad.ts' && u.location.range?.start === 20),
    ).toBe(true);
  });

  it('records numeric kinds', () => {
    expect(fn(index, 'src/bad.ts#floats').numericKinds).toEqual(['float_literal']);
    expect(fn(index, 'src/bad.ts#divide').numericKinds).toEqual(['division']);
    expect(fn(index, 'src/bad.ts#nan').numericKinds).toEqual(['nan']);
    expect(fn(index, 'src/bad.ts#big').numericKinds).toEqual(['bigint']);
  });

  it('does not report purely dynamic code as pure', () => {
    for (const symbol of ['src/bad.ts#useEval', 'src/bad.ts#useFunction', 'src/bad.ts#useProxy']) {
      expect(fn(index, symbol).purity).not.toBe('pure');
    }
    expect(fn(index, 'src/bad.ts#Box.current=').purity).toBe('impure');
  });

  it('does not flag strict comparisons between same-typed operands', () => {
    const clean = project({
      'src/ok.ts': 'export function ok(a: number, b: number): boolean { return a === b && a < b + 1; }\n',
    });
    expect(fn(analyze(clean), 'src/ok.ts#ok').unsupported).toEqual([]);
  });
});

describe('side effects', () => {
  const root = project({
    'src/effects.ts': `import { readFileSync } from 'node:fs';
import * as cp from 'child_process';

let counter = 0;
const cache: number[] = [];

export function logs(x: number): number {
  console.log(x);
  return x;
}
export function fetches(url: string): unknown {
  return fetch(url);
}
export function now(): number {
  return Date.now();
}
export function random(): number {
  return Math.random();
}
export function env(): string | undefined {
  return process.env.HOME;
}
export function bump(): number {
  counter += 1;
  return counter;
}
export function remember(x: number): void {
  cache.push(x);
}
export function mutateParam(xs: number[]): void {
  xs.push(1);
}
export function reads(file: string): string {
  return readFileSync(file, 'utf8');
}
export function spawns(): unknown {
  return cp.execSync('ls');
}
export function today(): Date {
  return new Date();
}
export function indirect(x: number): number {
  return logs(x);
}
export function localOnly(n: number): number {
  let total = 0;
  const xs: number[] = [];
  xs.push(n);
  total += n;
  return total;
}
`,
  });
  const index = analyze(root);
  const effects = (name: string) => fn(index, `src/effects.ts#${name}`);

  it.each([
    ['logs', 'console'],
    ['fetches', 'fetch'],
    ['now', 'Date.now'],
    ['random', 'Math.random'],
    ['env', 'process'],
    ['bump', 'assigns outer variable counter'],
    ['remember', 'mutates outer cache'],
    ['mutateParam', 'mutates parameter xs'],
    ['reads', 'io import node:fs'],
    ['spawns', 'io import child_process'],
    ['today', 'new Date()'],
    ['indirect', 'calls impure src/effects.ts#logs'],
  ])('%s is impure because of %s', (name, effect) => {
    const f = effects(name);
    expect(f.sideEffects).toContain(effect);
    expect(f.purity).toBe('impure');
  });

  it('local mutation keeps a function pure', () => {
    expect(effects('localOnly')).toMatchObject({ sideEffects: [], purity: 'pure' });
  });

  it('does not mistake a project function named like a global for the global', () => {
    const local = project({
      'src/calc.ts': `export function process(a: number): number { return a; }
export function run(a: number): number { return process(a); }
`,
    });
    const index2 = analyze(local);
    expect(fn(index2, 'src/calc.ts#run')).toMatchObject({
      sideEffects: [],
      purity: 'pure',
      calls: ['src/calc.ts#process'],
    });
  });
});

describe('file selection and safety', () => {
  it('excludes test files, declaration files and configured excludes', () => {
    const root = project({
      'src/a.ts': 'export const a = (n: number) => n;\n',
      'src/a.test.ts': 'export const t = (n: number) => n;\n',
      'src/b.spec.ts': 'export const s = (n: number) => n;\n',
      'src/types.d.ts': 'export declare function d(n: number): number;\n',
      'src/gen/x.generated.ts': 'export const g = (n: number) => n;\n',
      'src/skip/c.ts': 'export const c = (n: number) => n;\n',
    });
    const index = analyze(root, undefined, {
      analysis: { exclude: ['**/*.generated.*', '**/node_modules/**', 'src/skip/**'] },
    });
    expect(index.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(index.functions.map((f) => f.symbol)).toEqual(['src/a.ts#a']);
  });

  it('skips explicitly listed test files with a diagnostic', () => {
    const root = project({
      'src/a.ts': 'export const a = (n: number) => n;\n',
      'test/a.test.ts': 'export const t = 1;\n',
    });
    const index = analyze(root, ['src/a.ts', 'test/a.test.ts']);
    expect(index.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(index.diagnostics).toEqual([
      { file: 'test/a.test.ts', message: 'skipped: test file, not analyzed as source' },
    ]);
  });

  it('rejects explicit paths outside the root', () => {
    const root = project({ 'src/a.ts': 'export const a = 1;\n' });
    for (const bad of ['../escape.ts', path.join(root, 'src/a.ts')]) {
      expect(() => analyzeCode({ root, config: config(), files: [bad] })).toThrow(VeritasError);
    }
  });

  it('skips symlinks that escape the root instead of reading them', () => {
    const outside = project({ 'secret.ts': 'export function secret(n: number) { return n; }\n' });
    const root = project({ 'src/a.ts': 'export const a = (n: number) => n;\n' });
    symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src/link.ts'));
    const index = analyze(root);
    expect(index.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(index.functions.some((f) => f.name === 'secret')).toBe(false);
    expect(index.diagnostics[0]).toMatchObject({ file: 'src/link.ts' });
    expect(index.diagnostics[0]?.message).toContain('escapes the project root');
  });

  it('never executes project code', () => {
    const root = project({});
    const marker = path.join(root, 'executed.txt');
    writeFileSync(
      path.join(root, 'src.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport function f() { return 1; }\n`,
    );
    const index = analyze(root, ['src.ts']);
    expect(existsSync(marker)).toBe(false);
    expect(index.functions.map((f) => f.symbol)).toEqual(['src.ts#f']);
  });

  it('reports parse problems as diagnostics and keeps analyzing other files', () => {
    const root = project({
      'src/broken.ts': 'export function broken(n: number) {\n  return n +;\n}\n',
      'src/fine.ts': 'export function fine(n: number): number {\n  return n;\n}\n',
    });
    const index = analyze(root);
    expect(index.diagnostics.some((d) => d.file === 'src/broken.ts' && d.message.startsWith('line 2:'))).toBe(
      true,
    );
    expect(fn(index, 'src/fine.ts#fine').purity).toBe('pure');
  });

  it('returns an empty index for a project without sources', () => {
    const root = project({ 'README.md': '# nothing\n' });
    expect(analyze(root)).toEqual({ files: [], functions: [], diagnostics: [] });
  });
});

describe('behavior candidates', () => {
  const root = project({
    'src/api.ts': `export function find(name?: string | null): number {
  return name ? 1 : 0;
}
export function first(xs: number[]): number {
  return xs.length;
}
export function label(s: string): string {
  return s;
}
export function check(n: number): number {
  if (n > 10) {
    throw new Error('too big');
  }
  return n;
}
export function flipped(total: number): boolean {
  return 1000 < total;
}
export function encode(s: string): number[] {
  return [s.length];
}
export function decode(xs: number[]): string {
  return String(xs.length);
}
export function toWire(s: string): string {
  return s;
}
export function normalize(s: string): string {
  return s.trim();
}
export function answer(): number {
  return 42;
}
function internal(n: number): number {
  return n > 5 ? 1 : 0;
}
export const useInternal = (n: number): number => internal(n);
`,
  });
  const index = analyze(root);
  const candidates = inferBehaviorCandidates(index);
  const of = (name: string) => candidates.filter((c) => c.symbol === `src/api.ts#${name}`);

  it('proposes undefined and null for optional and nullable params', () => {
    const descriptions = of('find').map((c) => c.description);
    expect(descriptions).toContain('find: behaviour when name is undefined');
    expect(descriptions).toContain('find: behaviour when name is null');
    expect(descriptions).toContain('find: behaviour when name is the empty string');
  });

  it('proposes empty arrays, empty strings and negative numbers', () => {
    expect(of('first').map((c) => c.description)).toContain('first: behaviour when xs is an empty array');
    expect(of('label').map((c) => c.description)).toContain('label: behaviour when s is the empty string');
    expect(of('check').map((c) => c.description)).toContain('check: behaviour for negative n (and zero)');
  });

  it('proposes exception conditions with their guard', () => {
    const exception = of('check').filter((c) => c.template === 'exception_condition');
    expect(exception).toHaveLength(1);
    expect(exception[0]?.description).toBe("check: throws new Error('too big') when n > 10 (line 12)");
  });

  it('normalizes literal-on-the-left comparisons to the parameter side', () => {
    const boundary = of('flipped').find((c) => c.boundary);
    expect(boundary?.boundary).toEqual({ param: 'total', operator: '>', value: '1000' });
  });

  it('proposes round trips only with a matching partner and types', () => {
    const roundTrip = candidates.filter((c) => c.template === 'round_trip');
    expect(roundTrip.map((c) => c.symbol)).toEqual(['src/api.ts#encode']);
    expect(roundTrip[0]?.basis).toEqual(['name', 'type']);
    expect(of('toWire').some((c) => c.template === 'round_trip')).toBe(false);
  });

  it('proposes idempotence only for a pure same-typed normalizer', () => {
    const idem = candidates.filter((c) => c.template === 'idempotence');
    expect(idem.map((c) => c.symbol)).toEqual(['src/api.ts#normalize']);
    expect(of('label').some((c) => c.template === 'idempotence')).toBe(false);
  });

  it('does not force candidates when there is no evidence', () => {
    expect(of('answer')).toEqual([]);
  });

  it('only proposes candidates for exported functions', () => {
    expect(candidates.some((c) => c.symbol === 'src/api.ts#internal')).toBe(false);
  });

  it('is always inferred, schema-valid, with unique stable ids', () => {
    expect(candidates.every((c) => c.origin === 'inferred')).toBe(true);
    for (const c of candidates) expect(BehaviorCandidate.parse(c)).toEqual(c);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
    expect(inferBehaviorCandidates(analyze(root)).map((c) => c.id)).toEqual(candidates.map((c) => c.id));
  });

  it('adds comment basis when the jsdoc mentions the boundary value', () => {
    const commented = project({
      'src/c.ts':
        '/** Free above 500. */\nexport function free(total: number): boolean {\n  return total > 500;\n}\n',
    });
    const c = inferBehaviorCandidates(analyze(commented)).find((x) => x.boundary);
    expect(c?.basis).toEqual(['implementation', 'comment']);
  });

  it('notes unsupported constructs and non-pure functions on candidates', () => {
    const impure = project({
      'src/d.ts': 'export function half(n: number): number {\n  console.log(n);\n  return n / 2;\n}\n',
    });
    const notes = inferBehaviorCandidates(analyze(impure)).flatMap((c) => c.notes);
    expect(notes).toContain('purity is impure; results may depend on state or I/O');
    expect(notes.some((n) => n.includes('/ operator'))).toBe(true);
  });
});

describe('numeric, ordering, symmetry and usage candidates', () => {
  const root = project({
    'src/math.ts': `export function ratio(a: number, b: number): number {
  return a / b;
}
export function count(n: bigint): bigint {
  return n;
}
export function total(xs: number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum;
}
export function max(a: number, b: number): number {
  return a > b ? a : b;
}
export function subtract(a: number, b: number): number {
  return a - b;
}
export function fee(amount: number): number {
  return amount >= 1000 ? 0 : 50;
}
export function checkout(amount: number): number {
  if (amount >= 1000) return fee(amount);
  return fee(amount) + 1;
}
export function shipping(weight: number): number {
  return weight > 20 ? 10 : 5;
}
`,
  });
  const candidates = inferBehaviorCandidates(analyze(root));
  const of = (name: string) => candidates.filter((c) => c.symbol === `src/math.ts#${name}`);

  it('flags fractions, NaN and Infinity for number params, and division by zero', () => {
    expect(of('ratio').map((c) => c.description)).toEqual(
      expect.arrayContaining([
        'ratio: behaviour for non-integer, NaN, ±Infinity and unsafe-integer values of a',
        expect.stringContaining('ratio: division can give a fraction, or ±Infinity/NaN for a zero divisor'),
      ]),
    );
    expect(of('count').some((c) => c.description.includes('non-integer'))).toBe(false);
    expect(of('max').some((c) => c.description.includes('division'))).toBe(false);
  });

  it('asks whether a pure function over an array depends on element order', () => {
    expect(of('total').map((c) => [c.template, c.description])).toContainEqual([
      'custom',
      'total: whether the result depends on the order of xs; check a reordered xs and duplicate elements',
    ]);
  });

  it('proposes commutativity only for symmetric names with two same-typed params', () => {
    expect(of('max').filter((c) => c.template === 'commutativity').map((c) => c.description)).toEqual([
      'max(a, b) equals max(b, a)',
    ]);
    expect(of('subtract').some((c) => c.template === 'commutativity')).toBe(false);
  });

  it('records callers that compare against the same boundary as usage evidence', () => {
    const boundary = of('fee').find((c) => c.boundary?.value === '1000');
    expect(boundary?.basis).toContain('usage');
    expect(boundary?.description).toContain('checkout also compares against 1000 before calling it');
    expect(of('shipping').find((c) => c.boundary?.value === '20')?.basis).not.toContain('usage');
  });
});
