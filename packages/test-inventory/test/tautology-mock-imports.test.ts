import { VeritasConfig } from '@under18dev/veritas-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

describe('tautology, mocks, and imports', () => {
  it('flags literal and local-constant tautologies but not a project call assertion', () => {
    const root = tempProject({
      'src/value.ts': 'export function fn(value: number): number { return value; }\n',
      'test/tautology.test.ts': `
        import { expect, test } from 'vitest';
        import { fn } from '../src/value.js';
        const CONST = 1;
        test('number', () => expect(1).toBe(1));
        test('string', () => expect('a').toEqual('a'));
        test('const', () => expect(CONST).toBe(CONST));
        test('project', () => expect(fn(1)).toBe(1));
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

    expect(byName('number').suspicions).toContain('tautological_assertion');
    expect(byName('string').suspicions).toContain('tautological_assertion');
    expect(byName('const').suspicions).toContain('tautological_assertion');
    expect(byName('project').suspicions).not.toContain('tautological_assertion');
  });

  it('flags module mocks and spyOn mockReturnValue for the tested symbol', () => {
    const root = tempProject({
      'src/value.ts': 'export function fn(value: number): number { return value; }\n',
      'test/mocks.test.ts': `
        import { expect, test, vi } from 'vitest';
        import * as mod from '../src/value.js';
        vi.mock('../src/value.js');
        vi.spyOn(mod, 'fn').mockReturnValue(2);
        test('mocked', () => expect(mod.fn(1)).toBe(2));
      `,
    });
    const testCase = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    }).tests.at(0);

    if (!testCase) throw new Error('missing mocked test');

    expect(testCase.usesMocks).toBe(true);
    expect(testCase.suspicions).toContain('unconditional_mock');
  });

  it('resolves js imports, export-star, default, and namespace imports', () => {
    const root = tempProject({
      'src/named.ts': 'export function named(value: number): number { return value; }\n',
      'src/default.ts': 'export default function fallback(value: number): number { return value; }\n',
      'src/reexport.ts': "export * from './named.js';\n",
      'test/imports.test.ts': `
        import { expect, test } from 'vitest';
        import { named } from '../src/reexport.js';
        import fallback from '../src/default.js';
        import * as namespace from '../src/named.js';
        test('named', () => expect(named(1)).toBe(1));
        test('default', () => expect(fallback(1)).toBe(1));
        test('namespace', () => expect(namespace.named(1)).toBe(1));
      `,
    });
    const tests = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    }).tests;

    expect(tests.map((test) => test.calledSymbols)).toEqual([
      ['src/named.ts#named'],
      ['src/default.ts#default'],
      ['src/named.ts#named'],
    ]);
  });

  it('records that project code loading a mocked module could have called its mock, without calling it asserted', () => {
    const root = tempProject({
      'src/api.ts': 'export function send(message: string): void { void message; }\n',
      'src/log.ts':
        "import { send } from './api.js';\nexport function log(message: string): void { send(message); }\n",
      'src/unrelated.ts': 'export function idle(): number { return 1; }\n',
      'test/log.test.ts': `
        import { expect, test, vi } from 'vitest';
        import { send } from '../src/api.js';
        import * as api from '../src/api.js';
        import { log } from '../src/log.js';
        import { idle } from '../src/unrelated.js';
        vi.mock('../src/api.js');
        test('named', () => { log('hi'); expect(send).toHaveBeenCalledWith('hi'); });
        test('namespace', () => { log('hi'); expect(api.send).toHaveBeenCalled(); });
        test('not loading', () => { idle(); expect(send).not.toHaveBeenCalled(); });
        test('before the call', () => { expect(send).not.toHaveBeenCalled(); log('hi'); });
        test('self called', () => { log('hi'); send('x'); expect(send).toHaveBeenCalled(); });
        test('mocked module itself', () => { api.send('x'); expect(api.send).toHaveBeenCalled(); });
      `,
      'test/unmocked.test.ts': `
        import { expect, test, vi } from 'vitest';
        import { send } from '../src/api.js';
        import { log } from '../src/log.js';
        vi.spyOn(console, 'log');
        test('not mocked', () => { log('hi'); expect(send).toHaveBeenCalled(); });
      `,
    });
    const tests = inventoryTests({
      recognition: vitest.recognition,
      root,
      config: VeritasConfig.parse({}),
    }).tests;
    const asserted = (name: string) => {
      const test = tests.find((candidate) => candidate.name === name);

      if (!test) throw new Error(`missing test: ${name}`);

      return test.targetCalls.some((call) => call.asserted);
    };

    // Project code that loads the mocked module could have called the mock: recorded as a route, never as asserted.
    expect(asserted('named')).toBe(false);
    expect(asserted('namespace')).toBe(false);
    for (const name of ['named', 'namespace'])
      expect(tests.find((test) => test.name === name)?.suspicions).toContain('reachable_by_name');
    for (const name of [
      'not loading',
      'before the call',
      'self called',
      'mocked module itself',
      'not mocked',
    ])
      expect(tests.find((test) => test.name === name)?.suspicions).not.toContain('reachable_by_name');
    // The project code called does not load the mocked module, so it cannot have called the mock.
    expect(asserted('not loading')).toBe(false);
    // Read before project code ran.
    expect(asserted('before the call')).toBe(false);
    // The test calls the mock itself, so its calls may be the test's own.
    expect(asserted('self called')).toBe(false);
    expect(asserted('mocked module itself')).toBe(false);
    // Without vi.mock of that module, the import is the real function.
    expect(asserted('not mocked')).toBe(false);
  });
});
