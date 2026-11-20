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

  it('links the expected side of an assertion and the state of an object a project method ran on', () => {
    const byName = inventory(`${header}
      it('reversed', () => { expect([2, 3]).toContain(fn(1)); });
      it('state', () => { const c = new Counter(); c.inc(); expect(c.count).toBe(1); });
      it('project value method', () => { expect(items.includes(2)).toBe(true); });
    `);
    expect(byName('reversed').asserted).toBe(true);
    expect(byName('state')).toMatchObject({ symbols: ['src/math.ts#inc'], asserted: true });
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
});
