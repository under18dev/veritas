import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig, symbolId } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { analyzeCode, CodeIndex, type FunctionInfo } from '../src/index.js';

function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-ci-review-')));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

function analyze(files: Record<string, string>): CodeIndex {
  const index = analyzeCode({ root: project(files), config: parseConfig({}, null) });
  expect(CodeIndex.parse(index)).toEqual(index);
  return index;
}

function fn(index: CodeIndex, symbol: string): FunctionInfo {
  const found = index.functions.find((f) => f.symbol === symbol);
  if (!found) throw new Error(`no ${symbol}; have ${index.functions.map((f) => f.symbol).join(', ')}`);
  return found;
}

describe('purity is never pure for constructs outside the supported subset', () => {
  const index = analyze({
    'src/a.ts': `export async function f(x: number) { return x; }
export async function g(x: number) { return await Promise.resolve(x); }
export function* gen(x: number) { yield x; }
export class Box {
  v = 1;
  get current(): number { return 1; }
  read(): number { return this.v; }
}
export function args(x: number): number { return arguments.length + x; }
export function dyn(obj: Record<string, number>, k: string): number { return obj[k] ?? 0; }
export function nestedAsync(x: number): number {
  const later = async () => x;
  void later;
  return x;
}
export function half(x: number): number { return x / 2; }
export function scaled(x: number): number { return x * 0.5; }
export function count(x: number): number { return x + 1; }
`,
  });

  it.each([
    ['src/a.ts#f', 'async function'],
    ['src/a.ts#g', 'await'],
    ['src/a.ts#gen', 'generator function'],
    ['src/a.ts#Box.current', 'getter accessor'],
    ['src/a.ts#Box.read', 'this'],
    ['src/a.ts#args', 'arguments object'],
    ['src/a.ts#dyn', 'computed property access on parameter obj'],
    ['src/a.ts#nestedAsync', 'async function'],
  ])('%s lists %s and is unknown, not pure', (symbol, reason) => {
    const f = fn(index, symbol);
    expect(f.unsupported.map((u) => u.reason)).toContain(reason);
    expect(f.purity).toBe('unknown');
  });

  it('keeps purely numeric notes (division, float literals) pure: they do not affect side effects', () => {
    expect(fn(index, 'src/a.ts#half')).toMatchObject({
      purity: 'pure',
      numericKinds: ['integer_literal', 'division'],
    });
    expect(fn(index, 'src/a.ts#scaled')).toMatchObject({ purity: 'pure', numericKinds: ['float_literal'] });
    expect(fn(index, 'src/a.ts#count')).toMatchObject({ purity: 'pure', unsupported: [] });
  });

  it('propagates unknown purity from an unsupported callee', () => {
    const idx = analyze({
      'src/b.ts': `async function inner(x: number) { return x; }
export function outer(x: number) { void inner(x); return x; }
`,
    });
    expect(fn(idx, 'src/b.ts#inner').purity).toBe('unknown');
    expect(fn(idx, 'src/b.ts#outer').purity).toBe('unknown');
  });
});

describe('calls to same-project helpers resolve to symbol ids', () => {
  it('records a non-exported top-level helper in the same file as its symbol id', () => {
    const index = analyze({
      'src/m.ts': `function helper(x: number) { return x + 1; }
export function main(x: number) { return helper(x); }
`,
    });
    const main = fn(index, 'src/m.ts#main');
    expect(main.calls).toEqual([symbolId('src/m.ts', 'helper')]);
    expect(fn(index, 'src/m.ts#helper').exported).toBe(false);
    expect(main.purity).toBe('pure');
  });

  it('records a non-exported const arrow helper and a helper declared after its caller', () => {
    const index = analyze({
      'src/m.ts': `const twice = (x: number) => x * 2;
export function main(x: number) { return twice(later(x)); }
function later(x: number) { return x; }
`,
    });
    expect(fn(index, 'src/m.ts#main').calls).toEqual([
      symbolId('src/m.ts', 'twice'),
      symbolId('src/m.ts', 'later'),
    ]);
  });

  it('records helpers in other project files, exported under an alias, by their indexed symbol id', () => {
    const index = analyze({
      'src/util.ts': `function inner(x: number) { return x; }
export { inner as renamed };
`,
      'src/m.ts': `import { renamed } from './util.js';
export function main(x: number) { return renamed(x); }
`,
    });
    const ids = index.functions.map((f) => f.symbol);
    const [call] = fn(index, 'src/m.ts#main').calls;
    expect(call).toBe(symbolId('src/util.ts', 'renamed'));
    expect(ids).toContain(call);
  });

  it('records calls to anonymous default-exported functions and arrows by their indexed symbol id', () => {
    const index = analyze({
      'src/fn.ts': 'export default function (x: number) { return x; }\n',
      'src/arrow.ts': 'export default (x: number) => x + 1;\n',
      'src/m.ts': `import first from './fn.js';
import second from './arrow.js';
export function main(x: number) { return first(second(x)); }
`,
    });
    const ids = index.functions.map((f) => f.symbol);
    expect(ids).toEqual(expect.arrayContaining(['src/fn.ts#default', 'src/arrow.ts#default']));
    const main = fn(index, 'src/m.ts#main');
    expect(main.calls).toEqual(['src/fn.ts#default', 'src/arrow.ts#default']);
    expect(main.purity).toBe('pure');
  });

  it('keeps helpers nested inside the caller as callee text (not project symbols)', () => {
    const index = analyze({
      'src/m.ts': `export function main(x: number) {
  const inc = (k: number) => k + 1;
  return inc(x);
}
`,
    });
    expect(fn(index, 'src/m.ts#main').calls).toEqual(['inc']);
  });
});
