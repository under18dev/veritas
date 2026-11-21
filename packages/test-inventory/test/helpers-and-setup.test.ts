import { VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

const math = `
export function fn(value: number): number { return value + 1; }
export function run(callback: (value: number) => void): void { callback(1); }
export function list(): number[] { return [1, 2]; }
export const items = [1, 2, 3];
export class Counter { count = 0; inc(): void { this.count++; } }
`;

function inventory(testSource: string, extra: Record<string, string> = {}) {
  const root = tempProject({ 'src/math.ts': math, 'test/case.test.ts': testSource, ...extra });
  const result = inventoryTests({ root, config: VeritasConfig.parse({}) });

  return (name: string) => {
    const test = result.tests.find((candidate) => candidate.name === name);

    if (!test) throw new Error(`missing test: ${name}`);

    return {
      symbols: test.calledSymbols,
      asserted: test.targetCalls.some((call) => call.asserted),
      args: test.targetCalls.map((call) => call.args),
      suspicions: test.suspicions,
      assertionCount: test.assertionCount,
    };
  };
}

const header = `import { beforeEach, describe, expect, it } from 'vitest';
import { Counter, fn, items, list, run } from '../src/math.js';
`;

describe('test helpers', () => {
  it('links a call made inside a helper whose result the helper returns', () => {
    const test = inventory(`${header}
      function make(n: number) { const r = fn(n); return r; }
      it('returned', () => { expect(make(1)).toBe(2); });
    `)('returned');
    expect(test.symbols).toEqual(['src/math.ts#fn']);
    expect(test.asserted).toBe(true);
    // The helper's argument is not fn's, so it is not recorded as fn's input.
    expect(test.args).toEqual([[]]);
  });

  it('counts an assertion made inside the helper', () => {
    const test = inventory(`${header}
      function check(n: number) { expect(fn(n)).toBe(n + 1); }
      it('checks inside', () => { check(1); });
    `)('checks inside');
    expect(test.asserted).toBe(true);
    expect(test.suspicions).toEqual([]);
  });

  it('follows helpers imported from another test file', () => {
    const test = inventory(
      `${header}
      import { build } from './support.js';
      it('imported helper', () => { expect(build()).toBe(2); });
    `,
      { 'test/support.ts': `import { fn } from '../src/math.js';\nexport const build = () => fn(1);\n` },
    )('imported helper');
    expect(test.symbols).toEqual(['src/math.ts#fn']);
    expect(test.asserted).toBe(true);
  });

  it('treats assertion helpers kept under src/ as test code, through re-exports', () => {
    const extra = {
      'src/check.ts': `import { fn } from './math.js';
export function minLength(n: number) { return (value: string) => value.length >= n; }
export const label = (value: number) => String(fn(value));
`,
      // Imports expect from Vitest: an assertion helper, even though it lives in src/.
      'src/vitest/expectValid.ts': `import { expect } from 'vitest';
export function expectValid(check: (value: string) => boolean, values: string[]): void {
  for (const value of values) expect(check(value)).toBe(true);
}
export function expectNothing(check: unknown): void { expect(1).toBe(1); }
`,
      'src/vitest/index.ts': "export * from './expectValid.js';\n",
      // Imports only a type and a config helper from Vitest: still project code.
      'src/plugin.ts': `import type { expect } from 'vitest';
import { defineConfig } from 'vitest/config';
export function plugin(n: number): number { return n * 2; }
export const config = defineConfig;
`,
    };
    const get = inventory(
      `import { describe, expect, it } from 'vitest';
      import { minLength } from '../src/check.js';
      import { plugin } from '../src/plugin.js';
      import { expectNothing, expectValid } from '../src/vitest/index.js';
      describe('minLength', () => {
        const check = minLength(2);
        it('asserted through the helper', () => { expectValid(check, ['ab', 'abc']); });
        it('inline argument', () => { expectValid(minLength(1), ['a']); });
        it('helper ignores the argument', () => { expectNothing(minLength(3)); });
        it('plugin stays project code', () => { expect(plugin(1)).toBe(2); });
      });
    `,
      extra,
    );
    for (const name of ['asserted through the helper', 'inline argument']) {
      const test = get(name);
      expect(test.symbols, name).toEqual(['src/check.ts#minLength']);
      expect(test.asserted, name).toBe(true);
      expect(test.suspicions, name).not.toContain('no_assertion');
    }
    // The helper is followed (its assertion counts), but it does not check the value it is given.
    const ignored = get('helper ignores the argument');
    expect(ignored.symbols).toEqual(['src/check.ts#minLength']);
    expect(ignored.asserted).toBe(false);
    expect(ignored.suspicions).not.toContain('no_assertion');
    expect(get('plugin stays project code').symbols).toEqual(['src/plugin.ts#plugin']);
  });

  it('keeps the call a describe-level value comes from when a helper that calls project code receives it', () => {
    const get = inventory(
      `import { describe, it } from 'vitest';
      import { minLength } from '../src/check.js';
      import { expectValid } from './expect.js';
      describe('minLength', () => {
        const check = minLength(2);
        it('passed to the helper', () => { expectValid(check, ['ab']); });
      });
    `,
      {
        'src/check.ts': `import { fn } from './math.js';
export function minLength(n: number) { return (value: string) => value.length >= n; }
export const label = (value: number) => String(fn(value));
`,
        // The helper calls project code itself (label), and asserts on the check it is given.
        'test/expect.ts': `import { expect } from 'vitest';
import { label } from '../src/check.js';
export function expectValid(check: (value: string) => boolean, values: string[]): void {
  for (const value of values) expect(check(value)).toBe(label(1) !== '');
}
`,
      },
    );
    const test = get('passed to the helper');
    expect(test.symbols.sort()).toEqual(['src/check.ts#label', 'src/check.ts#minLength']);
    expect(test.asserted).toBe(true);
  });

  it('follows what an arrow helper returns from an enclosing variable', () => {
    const test = inventory(`${header}
      describe('suite', () => {
        const all = list();
        const pick = (n: number) => all.filter((x) => x === n);
        it('enclosing', () => { expect(pick(1)).toEqual([1]); });
      });
    `)('enclosing');
    expect(test.symbols).toEqual(['src/math.ts#list']);
    expect(test.asserted).toBe(true);
  });

  it('links what a generator helper yields, and not what it only computes', () => {
    const get = inventory(`${header}
      function* values(n: number) { for (let i = 0; i < n; i++) yield fn(i); }
      function* delegated(n: number) { yield* values(n); }
      function* unrelated(n: number) { fn(n); yield 1; }
      it('yielded', () => { for (const v of values(3)) expect(v).toBeGreaterThan(0); });
      it('delegated', () => { const vs = [...delegated(2)]; expect(vs).toEqual([1, 2]); });
      it('unrelated', () => { for (const v of unrelated(3)) expect(v).toBe(1); });
    `);
    expect(get('yielded').asserted).toBe(true);
    expect(get('delegated').asserted).toBe(true);
    expect(get('unrelated').symbols).toEqual(['src/math.ts#fn']);
    expect(get('unrelated').asserted).toBe(false);
  });

  it('follows a test helper that a built-in runs, but not one an assertion only names', () => {
    const get = inventory(`${header}
      const viaFn = (...args: number[]) => fn(args[0] ?? 0);
      const ignores = (value: number) => { fn(value); return 0; };
      it('mapped', () => { expect([1, 2].map(viaFn)).toEqual([2, 3]); });
      it('result ignored', () => { expect([1].map(ignores)).toEqual([0]); });
      it('named only', () => { expect(viaFn).toBeTypeOf('function'); });
    `);
    expect(get('mapped').symbols).toEqual(['src/math.ts#fn']);
    expect(get('mapped').asserted).toBe(true);
    expect(get('result ignored').symbols).toEqual(['src/math.ts#fn']);
    expect(get('result ignored').asserted).toBe(false);
    expect(get('named only').symbols).toEqual([]);
  });

  it('does not count a helper whose return value is unrelated to the project call', () => {
    const test = inventory(`${header}
      function setup() { fn(1); return 5; }
      it('unrelated return', () => { expect(setup()).toBe(5); });
    `)('unrelated return');
    expect(test.symbols).toEqual(['src/math.ts#fn']);
    expect(test.asserted).toBe(false);
  });

  it('terminates on recursive helpers', () => {
    const test = inventory(`${header}
      function down(n: number): number { return n > 0 ? down(n - 1) : fn(0); }
      it('recursive', () => { expect(down(3)).toBe(1); });
    `)('recursive');
    expect(test.symbols).toEqual(['src/math.ts#fn']);
    expect(test.asserted).toBe(true);
  });
});

describe('shared setup', () => {
  it('links a describe-level value and a let set in beforeEach', () => {
    const byName = inventory(`${header}
      describe('suite', () => {
        const shared = fn(1);
        let fresh: number;
        beforeEach(() => { fresh = fn(2); });
        it('describe const', () => { expect(shared).toBe(2); });
        it('hook let', () => { expect(fresh).toBe(3); });
        it('ignores it', () => { expect(1).toBe(1); });
      });
    `);
    expect(byName('describe const')).toMatchObject({ symbols: ['src/math.ts#fn'], asserted: true });
    expect(byName('hook let')).toMatchObject({ symbols: ['src/math.ts#fn'], asserted: true });
    expect(byName('ignores it').suspicions).toEqual(['tautological_assertion', 'target_not_called']);
  });
});

describe('test registration', () => {
  it('finds the callback before a timeout and after an options object', () => {
    const byName = inventory(`${header}
      it('timeout', () => { expect(fn(1)).toBe(2); }, 10_000);
      it('options', { timeout: 10_000 }, () => { expect(fn(1)).toBe(2); });
      describe('suite with options', () => { it('inner', () => { expect(fn(1)).toBe(2); }); }, 10_000);
    `);

    for (const name of ['timeout', 'options', 'inner'])
      expect(byName(name), name).toMatchObject({ assertionCount: 1, asserted: true });
  });
});

describe('result flow', () => {
  it('links the error caught from a project call', () => {
    const byName = inventory(`${header}
      it('caught', () => { try { fn(1); } catch (error) { expect(error).toBeInstanceOf(Error); } });
      it('caught elsewhere', () => {
        fn(1);
        try { JSON.parse('x'); } catch (error) { expect(error).toBeInstanceOf(Error); }
      });
    `);
    expect(byName('caught').asserted).toBe(true);
    expect(byName('caught elsewhere').asserted).toBe(false);
  });

  it('links what a callback given to project code writes, inline or through a variable', () => {
    const byName = inventory(`${header}
      it('inline', () => { const seen: number[] = []; run((v) => seen.push(v)); expect(seen).toEqual([1]); });
      it('variable', () => {
        let last = 0;
        const record = (v: number) => { last = v; };
        run(record);
        expect(last).toBe(1);
      });
      it('non-project callback', () => {
        const seen: number[] = [];
        [1].forEach((v) => seen.push(v));
        fn(1);
        expect(seen).toEqual([1]);
      });
    `);
    expect(byName('inline').asserted).toBe(true);
    expect(byName('variable').asserted).toBe(true);
    expect(byName('non-project callback').asserted).toBe(false);
  });

  it('links constructor calls, tagged templates, type-level checks and objects changed in place', () => {
    const extra = {
      'src/more.ts': `export class Url { constructor(public input: string) { if (typeof input !== 'string') throw new TypeError('x'); } }
export const dedent = (strings: TemplateStringsArray, ...values: unknown[]) => strings.join('').trim();
export function merge(target: Record<string, unknown>, source: Record<string, unknown>) { Object.assign(target, source); }
export function double(n: number) { return n * 2; }
`,
    };
    const byName = inventory(
      `import { expect, expectTypeOf, it } from 'vitest';
import { Url, dedent, double, merge } from '../src/more.js';
it('constructor', () => { expect(() => new Url(1 as never)).toThrow(TypeError); });
it('tagged template', () => { expect(dedent\`  a  \`).toBe('a'); });
it('type-level', () => { expectTypeOf(double(1)).toEqualTypeOf<number>(); });
it('changed in place', () => { const target = {}; merge(target, { a: 1 }); expect(target).toEqual({ a: 1 }); });
it('primitive argument', () => { const n = 2; double(n); expect(n).toBe(2); });
`,
      extra,
    );
    expect(byName('constructor')).toMatchObject({ symbols: ['src/more.ts#Url'], asserted: true });
    expect(byName('tagged template')).toMatchObject({ symbols: ['src/more.ts#dedent'], asserted: true });
    expect(byName('type-level')).toMatchObject({ symbols: ['src/more.ts#double'], asserted: true });
    expect(byName('type-level').suspicions).toEqual(['type_level_only']);
    expect(byName('changed in place')).toMatchObject({ symbols: ['src/more.ts#merge'], asserted: true });
    // A number cannot be changed by the function it is passed to.
    expect(byName('primitive argument').asserted).toBe(false);
  });

  it('follows aliases, functions passed as values, mocks and arrays filled by project code', () => {
    const extra = {
      'src/iter.ts': `export function each(items: number[], cb: (n: number) => void) { for (const n of items) cb(n); }
export function drop(items: number[]) { return items.slice(1); }
export function chunk(items: number[]) { return [items]; }
`,
    };
    const byName = inventory(
      `import { expect, it, vi } from 'vitest';
import { chunk, drop, each } from '../src/iter.js';
const run = each;
it('alias', () => { const seen: number[] = []; run([1, 2], (n) => seen.push(n)); expect(seen).toEqual([1, 2]); });
it('passed as a value', () => { expect([[1, 2], [3]].map(drop)).toEqual([[2], []]); });
it('mock', () => { const cb = vi.fn(); each([], cb); expect(cb).toHaveBeenCalledTimes(0); });
it('filled array', () => { const out: number[] = []; each([3], (n) => { out.push(n); }); expect(out).toEqual([3]); });
it('unchanged input', () => { const input = [1, 2]; chunk(input); expect(input).toEqual([1, 2]); });
it('really constant', () => { const expected = [1]; expect([1]).toEqual(expected); });
`,
      extra,
    );
    expect(byName('alias')).toMatchObject({ symbols: ['src/iter.ts#each'], asserted: true });
    expect(byName('passed as a value')).toMatchObject({ symbols: ['src/iter.ts#drop'], asserted: true });
    expect(byName('mock')).toMatchObject({ symbols: ['src/iter.ts#each'], asserted: true });
    // An array project code fills, or one it might change, is not a compile-time constant.
    expect(byName('filled array').suspicions).not.toContain('tautological_assertion');
    expect(byName('unchanged input').suspicions).not.toContain('tautological_assertion');
    expect(byName('really constant').suspicions).toContain('tautological_assertion');
  });

  it('links what project code passes to a callback the test asserts on', () => {
    const get = inventory(
      `${header}
      import { mapKeys, register } from '../src/keys.js';
      it('inline callback', () => {
        mapKeys({ a: 1 }, (key, value) => { expect(key).toBe('a'); expect(value).toBe(1); return key; });
      });
      it('callback in a variable', () => {
        const mapper = (key: string) => { expect(key).toBe('a'); return key; };
        mapKeys({ a: 1 }, mapper);
      });
      it('built-in callback', () => { fn(1); [1].forEach((x) => { expect(x).toBe(1); }); });
      it('stored, never called', () => { register((x: number) => { expect(x).toBe(1); }); });
    `,
      {
        'src/keys.ts': `
export function mapKeys(o: Record<string, number>, f: (k: string, v: number) => string) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [f(k, v), v]));
}
const handlers: unknown[] = [];
export function register(handler: (x: number) => void): void { handlers.push(handler); }
`,
      },
    );
    expect(get('inline callback').asserted).toBe(true);
    expect(get('callback in a variable').asserted).toBe(true);
    expect(get('built-in callback').asserted).toBe(false);
    expect(get('stored, never called').asserted).toBe(false);
  });

  it('links mocks passed in options, wrapped by other calls, or handed over in shared setup', () => {
    const get = inventory(
      `import { beforeEach, describe, expect, it, vi } from 'vitest';
      import { clone, debounce } from '../src/mocks.js';
      const wrap = (f: () => void) => f;
      it('options object', () => {
        const cloneObject = vi.fn((o: object) => o);
        clone({ a: 1 }, { cloneObject });
        expect(cloneObject).toHaveBeenCalledTimes(1);
      });
      it('wrapped', () => {
        const onDone = vi.fn().mockReturnValue(1);
        debounce({}, wrap(onDone))();
        expect(onDone).toHaveBeenCalled();
      });
      it('not given to project code', () => {
        const unused = vi.fn();
        wrap(unused)();
        clone({}, {});
        expect(unused).toHaveBeenCalled();
      });
      describe('debounced', () => {
        let func: () => void;
        const mockFunc = vi.fn();
        beforeEach(() => { func = debounce({ delay: 1 }, mockFunc); });
        it('hook', () => { func(); expect(mockFunc).toHaveBeenCalledTimes(1); });
      });
      const other = vi.fn();
      describe('elsewhere', () => {
        it('mock handed over only in another describe', () => {
          clone({}, {});
          expect(other).toHaveBeenCalled();
        });
        it('mock handed over only in another test', () => {
          clone({}, {});
          expect(other).toHaveBeenCalled();
        });
      });
      describe('sibling', () => {
        beforeEach(() => { debounce({}, other); });
      });
      it('other test passes it', () => { debounce({}, other); });
    `,
      {
        'src/mocks.ts': `
export function clone<T>(value: T, options: { cloneObject?: (o: object) => unknown }): T {
  options.cloneObject?.(value as object);
  return value;
}
export function debounce(options: { delay?: number }, f: () => void): () => void { return () => f(); }
`,
      },
    );
    expect(get('options object').asserted).toBe(true);
    expect(get('wrapped').asserted).toBe(true);
    expect(get('hook').asserted).toBe(true);
    expect(get('not given to project code').asserted).toBe(false);
    expect(get('mock handed over only in another describe').asserted).toBe(false);
    expect(get('mock handed over only in another test').asserted).toBe(false);
  });

  it('links a spy on a method of an object handed to project code', () => {
    const get = inventory(
      `import { expect, it, vi } from 'vitest';
      import { cached, fn } from '../src/cache.js';
      it('spied object passed', () => {
        const source = { run: (x: number) => x };
        const run = vi.spyOn(source, 'run').mockName('run');
        const wrapped = cached(source);
        wrapped(1);
        wrapped(1);
        expect(run).toHaveBeenCalledTimes(1);
      });
      it('spied object kept', () => {
        const source = { run: (x: number) => x };
        const run = vi.spyOn(source, 'run');
        fn(1);
        source.run(1);
        expect(run).toHaveBeenCalledTimes(1);
      });
    `,
      {
        'src/cache.ts': `
export function cached(source: { run: (x: number) => number }) {
  const seen = new Map<number, number>();
  return (x: number) => seen.get(x) ?? seen.set(x, source.run(x)).get(x);
}
export const fn = (x: number) => x;
`,
      },
    );
    expect(get('spied object passed').asserted).toBe(true);
    expect(get('spied object kept').asserted).toBe(false);
  });

  it('links what the traps of a proxy handed to project code record', () => {
    const get = inventory(`${header}
      it('inline proxy', () => {
        const keys: PropertyKey[] = [];
        fn(new Proxy({}, { get(t, k) { keys.push(k); return 1; } }) as never);
        expect(keys).toEqual(['valueOf']);
      });
      it('proxy in a variable', () => {
        const keys: PropertyKey[] = [];
        const entry = new Proxy({ a: 1 }, { get: (t, k) => { keys.push(k); return 1; } });
        fn(entry as never);
        expect(keys).toEqual(['a']);
      });
      it('proxy never handed over', () => {
        const keys: PropertyKey[] = [];
        const entry = new Proxy({ a: 1 }, { get: (t, k) => { keys.push(k); return 1; } });
        fn(1);
        void entry.a;
        expect(keys).toEqual(['a']);
      });
    `);
    expect(get('inline proxy').asserted).toBe(true);
    expect(get('proxy in a variable').asserted).toBe(true);
    expect(get('proxy never handed over').asserted).toBe(false);
  });

  it('links what a continuation of a project call writes or receives', () => {
    const get = inventory(
      `${header}
      import { Gate, load } from '../src/gate.js';
      it('then writes', async () => {
        const values: number[] = [];
        const gate = new Gate();
        gate.acquire().then(() => { values.push(3); });
        await gate.flush();
        expect(values).toEqual([3]);
      });
      it('then receives', async () => {
        await load().then((value) => { expect(value).toBe(1); });
      });
      it('catch on a stored promise', async () => {
        let failed = false;
        const pending = load();
        await pending.catch(() => { failed = true; });
        expect(failed).toBe(false);
      });
      it('continuation of something else', async () => {
        const values: number[] = [];
        load();
        await Promise.resolve().then(() => { values.push(1); });
        expect(values).toEqual([1]);
      });
    `,
      {
        'src/gate.ts': `
export class Gate { async acquire(): Promise<void> {} async flush(): Promise<void> {} }
export async function load(): Promise<number> { return 1; }
`,
      },
    );
    expect(get('then writes').asserted).toBe(true);
    expect(get('then receives').asserted).toBe(true);
    expect(get('catch on a stored promise').asserted).toBe(true);
    expect(get('continuation of something else').asserted).toBe(false);
  });

  it('links an awaited project call to an assertion on clock readings taken around it', () => {
    const get = inventory(
      `${header}
      import { sleep } from '../src/sleep.js';
      it('bracketed', async () => {
        const before = Date.now();
        const promise = sleep(1000);
        await promise;
        const after = Date.now();
        expect(after).toBeGreaterThanOrEqual(before + 1000);
      });
      it('difference', async () => {
        const start = performance.now();
        await sleep(10);
        const end = performance.now();
        expect(end - start).toBeGreaterThanOrEqual(10);
      });
      it('not around the call', async () => {
        await sleep(10);
        const before = Date.now();
        await Promise.resolve();
        const after = Date.now();
        expect(after).toBeGreaterThanOrEqual(before);
      });
      it('one reading', async () => {
        await sleep(10);
        const now = new Date();
        expect(now).toBeDefined();
      });
    `,
      { 'src/sleep.ts': 'export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n' },
    );
    expect(get('bracketed').asserted).toBe(true);
    expect(get('difference').asserted).toBe(true);
    expect(get('not around the call').asserted).toBe(false);
    expect(get('one reading').asserted).toBe(false);
  });

  it('marks a test that asserts only on constants recorded after awaiting a project call', () => {
    const get = inventory(
      `${header}
      import { Gate } from '../src/gate.js';
      it('progress', async () => {
        const values: number[] = [];
        const gate = new Gate();
        await gate.acquire();
        values.push(1);
        await gate.acquire();
        values.push(2);
        expect(values).toEqual([1, 2]);
      });
      it('counter', async () => {
        let reached = 0;
        await new Gate().acquire();
        reached++;
        expect(reached).toBe(1);
      });
      it('recorded before the await', async () => {
        const values: number[] = [];
        values.push(1);
        await new Gate().acquire();
        expect(values).toEqual([1]);
      });
      it('conditional record', async () => {
        const values: number[] = [];
        const gate = new Gate();
        await gate.acquire();
        if (gate) values.push(1);
        expect(values).toEqual([1]);
      });
      it('no await', () => {
        const values: number[] = [];
        new Gate();
        values.push(1);
        expect(values).toEqual([1]);
      });
      it('awaits something else', async () => {
        const values: number[] = [];
        new Gate();
        await Promise.resolve();
        values.push(1);
        expect(values).toEqual([1]);
      });
    `,
      { 'src/gate.ts': 'export class Gate { async acquire(): Promise<void> {} }\n' },
    );
    expect(get('progress').suspicions).toEqual(['progress_only']);
    expect(get('counter').suspicions).toEqual(['progress_only']);

    for (const name of [
      'recorded before the await',
      'conditional record',
      'no await',
      'awaits something else',
    ])
      expect(get(name).suspicions, name).not.toContain('progress_only');
  });

  it('links counters a callback increments and locals that store project results', () => {
    const extra = {
      'src/fns.ts': `export function each(items: number[], cb: () => void) { for (const _ of items) cb(); }
export function parse(text: string) { return Number(text); }
export function create(proto: object) { return Object.create(proto); }
`,
    };
    const byName = inventory(
      `import { expect, it } from 'vitest';
import { create, each, parse } from '../src/fns.js';
it('increment', () => { let count = 0; each([1, 2], () => { count++; }); expect(count).toBe(2); });
it('pushed', () => { const out: number[] = []; ['1'].forEach((t) => { out.push(parse(t)); }); expect(out).toEqual([1]); });
it('consumed by another call', async () => {
  let running = 0;
  const tasks = Array.from({ length: 3 }, async () => { running++; running--; });
  each(tasks as never, () => {});
  expect(running).toBe(0);
});
it('stored on a property', () => {
  function Shape() {}
  const holder: { proto?: object } = {};
  holder.proto = create(Shape.prototype);
  expect(holder.proto instanceof Shape).toBe(true);
});
`,
      extra,
    );
    expect(byName('increment')).toMatchObject({ symbols: ['src/fns.ts#each'], asserted: true });
    // The callbacks ran inside Array.from, before project code got their promises.
    expect(byName('consumed by another call').asserted).toBe(false);
    expect(byName('pushed')).toMatchObject({ symbols: ['src/fns.ts#parse'], asserted: true });
    expect(byName('stored on a property')).toMatchObject({ symbols: ['src/fns.ts#create'], asserted: true });
  });

  it('does not link functions or objects that project code only stores or reads', () => {
    const extra = {
      'src/store.ts': `const registry: unknown[] = [];
export function register(fn: (n: number) => number) { registry.push(fn); return true; }
export function double(n: number) { return n * 2; }
export function observe(x: { a: number }) { return x.a > 0; }
export function touch(x: { a: number }) { x.a += 1; }
export function apply(xs: number[], fn: (n: number) => number) { return xs.map((n) => fn(n)); }
export function run(options: { cb: () => void }) { options.cb(); }
export function runWith(options: { cb: (n: number) => number }) { return options.cb(1); }
export function inspect(fn: (n: number) => number) { return typeof fn.call; }
`,
    };
    const byName = inventory(
      `import { expect, it } from 'vitest';
import { apply, double, inspect, observe, register, run, runWith, touch } from '../src/store.js';
it('stored', () => { expect(register(double)).toBe(true); });
it('read only', () => { const x = { a: 1 }; observe(x); expect(x).toEqual({ a: 1 }); });
it('changed', () => { const x = { a: 1 }; touch(x); expect(x).toEqual({ a: 2 }); });
it('called', () => { expect(apply([1], double)).toEqual([2]); });
it('options function', () => { expect(runWith({ cb: double })).toBe(2); });
it('inspected', () => { expect(inspect(double)).toBe('function'); });
it('stored by a built-in', () => { expect(Object.assign({}, { cb: double }).cb).toBeDefined(); });
it('options callback', () => { let count = 0; run({ cb: () => { count++; } }); expect(count).toBe(1); });
`,
      extra,
    );
    // register is asserted; double, which it only stores, is not counted as called.
    expect(byName('stored').symbols).toEqual(['src/store.ts#register']);
    // apply calls the function it is given, and run calls a callback given in an options object.
    expect(byName('called').symbols).toEqual(['src/store.ts#apply', 'src/store.ts#double']);
    expect(byName('options callback')).toMatchObject({ symbols: ['src/store.ts#run'], asserted: true });
    expect(byName('options function').symbols).toEqual(['src/store.ts#runWith', 'src/store.ts#double']);
    // A built-in given an object that holds a function only stores it.
    expect(byName('stored by a built-in').symbols).toEqual([]);
    // Reading `fn.call` does not call fn.
    expect(byName('inspected').symbols).toEqual(['src/store.ts#inspect']);
    // observe only reads x, so asserting on x checks nothing observe produced.
    expect(byName('read only').asserted).toBe(false);
    expect(byName('changed').asserted).toBe(true);
  });

  it('reads assertions on a test context, type checks without expectTypeOf, and shared suites', () => {
    const extra = {
      'src/glob.ts': `export function matches(glob: string, path: string) { return glob === path; }
export type Pair<T> = [T, T];
`,
    };
    const byName = inventory(
      `import { beforeEach, describe as vDescribe, expect, it as vIt } from 'vitest';
import { matches, type Pair } from '../src/glob.js';
type Assert = { true: (v: unknown) => void; is: (a: unknown, b: unknown) => void };
const describe = (name: string, fn: (it: (label: string, body: (t: Assert) => void) => void) => void) =>
  vDescribe(name, () => fn((label, body) => vIt(label, () => body({ true: (v) => expect(v).toBe(true), is: (a, b) => expect(a).toBe(b) }))));
describe('glob', (it) => {
  it('context', (t) => { t.true(matches('a', 'a')); });
});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
const util = { assertEqual: <A, B>(_: Equal<A, B>) => {} };
vIt('type alias check', () => { type _check = Expect<Equal<Pair<number>, [number, number]>>; });
vIt('typed assert call', () => { util.assertEqual<Pair<string>, [string, string]>(true); });
function runTest(fn: (a: string, b: string) => boolean) {
  vIt('suite', () => { expect(fn('a', 'a')).toBe(true); });
}
runTest(matches);
vIt('local thrower', () => { const block = () => matches(1 as never, 'a'); expect(block).toThrow(); });
vIt('compiles', () => { function _check(a: string) { matches(a, a); } });
function expectValue<T>(v: T) { if (v !== true) throw new Error('no'); }
vIt('typed value check', () => { expectValue<boolean>(matches('a', 'a')); });
function lexicalSuite() {
  const expected = process.env.EXPECTED;
  vIt('lexical', () => { expect(1).toBe(expected); });
}
lexicalSuite();
const hookSuite = (getEnv: () => { fn: () => string }) => {
  let fn: () => string;
  vDescribe('hook suite', () => {
    beforeEach(() => { ({ fn } = getEnv()); });
    vIt('from hook', () => { expect(fn()).toBe('x'); });
  });
};
hookSuite(() => ({ fn: () => 'x' }));
vIt('local value', () => { const later = () => matches('a', 'a'); expect(later).toBeDefined(); });
`,
      extra,
    );
    expect(byName('context')).toMatchObject({ symbols: ['src/glob.ts#matches'], asserted: true });
    expect(byName('context').suspicions).toEqual([]);
    expect(byName('type alias check').suspicions).toEqual(['type_level_only']);
    expect(byName('typed assert call').suspicions).toEqual(['type_level_only']);
    // What `fn` is comes from runTest's caller.
    expect(byName('suite').suspicions).toEqual(['caller_supplied']);
    // The matcher runs the local function, so its call is checked.
    expect(byName('local thrower')).toMatchObject({ symbols: ['src/glob.ts#matches'], asserted: true });
    // A typed helper given a runtime value checks that value, not only types.
    expect(byName('typed value check').suspicions).not.toContain('type_level_only');
    // A suite's own lexical value is not supplied by a caller.
    expect(byName('lexical').suspicions).not.toContain('caller_supplied');
    // Values set from the suite's parameter in a hook are.
    expect(byName('from hook').suspicions).toEqual(['caller_supplied']);
    // toBeDefined only compares the function as a value; it does not run it.
    expect(byName('local value').asserted).toBe(false);
    // Declares a function and never runs it: a check that it compiles.
    expect(byName('compiles').suspicions).toEqual(['type_level_only']);
  });

  it('treats JSX rendered with a JSX runtime of the project as a call it cannot follow', () => {
    const root = tempProject({
      'src/math.ts': math,
      'src/jsx-runtime.ts': 'export function jsx(tag: string) { return "<" + tag + "/>"; }\n',
      'test/render.test.tsx': `/** @jsxImportSource ../src */
import { expect, it } from 'vitest';
it('renders', () => { const element = <hr />; expect(String(element)).toBe('<hr/>'); });
`,
    });
    const test = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests.find(
      (t) => t.name === 'renders',
    );
    expect(test?.suspicions).toEqual(['opaque_call']);
  });

  it('links the expected side of an assertion and the state of an object a project method ran on', () => {
    const byName = inventory(`${header}
      it('reversed', () => { expect([2, 3]).toContain(fn(1)); });
      it('state', () => { const c = new Counter(); c.inc(); expect(c.count).toBe(1); });
      it('project value method', () => { expect(items.includes(2)).toBe(true); });
    `);
    expect(byName('reversed').asserted).toBe(true);
    // The constructor is project code too.
    expect(byName('state')).toMatchObject({
      symbols: ['src/math.ts#Counter', 'src/math.ts#inc'],
      asserted: true,
    });
    expect(byName('project value method')).toMatchObject({ symbols: ['src/math.ts#items'], asserted: true });
    // The method's argument is not an input of `items`.
    expect(byName('project value method').args).toEqual([[]]);
  });
});

describe('code static analysis cannot follow', () => {
  it('marks child processes and dynamic imports instead of claiming nothing is called', () => {
    const byName = inventory(`${header}
      import { spawnSync } from 'node:child_process';
      it('child process', () => { expect(spawnSync('node', ['-v']).status).toBe(0); });
      it('dynamic import', async () => { const m = await import('../src/math.js'); expect(m).toBeDefined(); });
    `);
    expect(byName('child process').suspicions).toEqual(['opaque_call']);
    expect(byName('dynamic import').suspicions).toEqual(['opaque_call']);
  });

  it('marks code compiled by node:vm as opaque, and leaves other vm functions alone', () => {
    const byName = inventory(`${header}
      import vm, { runInNewContext } from 'node:vm';
      import * as nodeVm from 'vm';
      it('runInNewContext', () => { expect(runInNewContext('fn(1)', { fn })).toBe(2); });
      it('script', () => { expect(new vm.Script('fn(1)').runInNewContext({ fn })).toBe(2); });
      it('namespace', () => { expect(nodeVm.runInThisContext('1')).toBe(1); });
      it('isContext', () => { expect(vm.isContext({})).toBe(false); });
    `);

    for (const name of ['runInNewContext', 'script', 'namespace'])
      expect(byName(name).suspicions, name).toContain('opaque_call');
    expect(byName('isContext').suspicions).not.toContain('opaque_call');
  });
});
