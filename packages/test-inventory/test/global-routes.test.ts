import { VeritasConfig } from '@under18dev/veritas-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

/**
 * For a project and one test file, whether each named test has an asserted project call (`asserted`), only a call
 * whose code could reach what it reads (`reachable`, never counted as asserted), or neither (`none`).
 */
function asserted(
  files: Record<string, string>,
  test: string,
): (name: string) => 'asserted' | 'reachable' | 'none' {
  const root = tempProject({ ...files, 'test/subject.test.ts': test });
  const tests = inventoryTests({
    recognition: vitest.recognition,
    root,
    config: VeritasConfig.parse({}),
  }).tests;

  return (name) => {
    const found = tests.find((candidate) => candidate.name === name);

    if (!found) throw new Error(`missing test: ${name}`);

    if (found.targetCalls.some((call) => call.asserted)) return 'asserted';

    if (found.suspicions.includes('reachable_by_name')) {
      expect(found.targetCalls.some((call) => call.reachedVia?.length)).toBe(true);

      return 'reachable';
    }

    return 'none';
  };
}

describe('links through globals and mocked modules', () => {
  it('links a page read after a project call whose code uses the global document', () => {
    const byName = asserted(
      {
        'src/theme.ts':
          "export function applyTheme(name: string): void { document.documentElement.setAttribute('data-theme', name); }\n",
        'src/pure.ts': 'export function idle(): number { return 1; }\n',
      },
      `
        import { expect, it } from 'vitest';
        import { applyTheme } from '../src/theme.js';
        import { idle } from '../src/pure.js';
        it('after the call', () => {
          applyTheme('dark');
          expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        });
        it('before the call', () => {
          const before = document.documentElement.getAttribute('data-theme');
          applyTheme('dark');
          expect(before).toBeNull();
        });
        it('code without document', () => {
          idle();
          expect(document.documentElement.getAttribute('data-theme')).toBeNull();
        });
        it('what the test wrote', () => {
          applyTheme('dark');
          document.documentElement.innerHTML = '<p>x</p>';
          expect(document.documentElement.innerHTML).toContain('x');
        });
      `,
    );

    expect(byName('after the call')).toBe('reachable');
    expect(byName('before the call')).toBe('none');
    expect(byName('code without document')).toBe('none');
    expect(byName('what the test wrote')).toBe('none');
  });

  it('links a spy on a global object or prototype when project code uses that API', () => {
    const byName = asserted(
      {
        'src/scroll.ts':
          "export function reveal(el: Element): void { el.scrollIntoView({ block: 'nearest' }); }\nexport function listen(): () => void { const f = () => {}; document.addEventListener('keydown', f); return () => document.removeEventListener('keydown', f); }\n",
        'src/pure.ts': 'export function idle(): number { return 1; }\n',
      },
      `
        import { expect, it, vi } from 'vitest';
        import { reveal, listen } from '../src/scroll.js';
        import { idle } from '../src/pure.js';
        it('prototype spy', () => {
          const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
          reveal(document.body);
          expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
        });
        it('document spy', () => {
          const removeSpy = vi.spyOn(document, 'removeEventListener');
          const stop = listen();
          stop();
          expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
        });
        it('code without the API', () => {
          const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
          idle();
          expect(spy).not.toHaveBeenCalled();
        });
        it('self-called spy', () => {
          const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
          reveal(document.body);
          document.body.scrollIntoView();
          expect(spy).toHaveBeenCalled();
        });
        it('read before the call', () => {
          const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
          expect(spy).not.toHaveBeenCalled();
          reveal(document.body);
        });
      `,
    );

    expect(byName('prototype spy')).toBe('reachable');
    expect(byName('document spy')).toBe('reachable');
    expect(byName('code without the API')).toBe('none');
    expect(byName('self-called spy')).toBe('none');
    expect(byName('read before the call')).toBe('none');
  });

  it('links a mock the test puts into a global that project code reads', () => {
    const byName = asserted(
      {
        'src/models.ts':
          'declare global { interface Window { monaco?: { dispose(): void } } }\nexport function closeAll(): void { window.monaco?.dispose(); }\n',
        'src/pure.ts': 'export function idle(): number { return 1; }\n',
        'test/harness.ts':
          'export function setMonaco(extra: Record<string, unknown> = {}): void { (window as unknown as Record<string, unknown>).monaco = { version: 1, ...extra }; }\n',
      },
      `
        import { expect, it, vi } from 'vitest';
        import { closeAll } from '../src/models.js';
        import { idle } from '../src/pure.js';
        import { setMonaco } from './harness.js';
        it('assigned', () => {
          const dispose = vi.fn();
          window.monaco = { dispose };
          closeAll();
          expect(dispose).toHaveBeenCalled();
        });
        it('through a helper', () => {
          const dispose = vi.fn();
          const models = [{ dispose }];
          setMonaco({ editor: { getModels: () => models } });
          closeAll();
          expect(dispose).toHaveBeenCalledTimes(1);
        });
        it('stubbed', () => {
          const dispose = vi.fn();
          vi.stubGlobal('monaco', { dispose });
          closeAll();
          expect(dispose).toHaveBeenCalled();
        });
        it('code without the global', () => {
          const dispose = vi.fn();
          window.monaco = { dispose };
          idle();
          expect(dispose).not.toHaveBeenCalled();
        });
        it('kept out of the global', () => {
          const dispose = vi.fn();
          const unused = vi.fn();
          window.monaco = { dispose };
          closeAll();
          expect(unused).not.toHaveBeenCalled();
        });
      `,
    );

    expect(byName('assigned')).toBe('reachable');
    expect(byName('through a helper')).toBe('reachable');
    expect(byName('stubbed')).toBe('reachable');
    expect(byName('code without the global')).toBe('none');
    expect(byName('kept out of the global')).toBe('none');
  });

  it('links a mock a mocked function returns, or a module mock factory holds, to code that loads the module', () => {
    const byName = asserted(
      {
        'src/store.ts':
          "import { load } from './backend.js';\nexport async function save(v: string): Promise<void> { const s = await load(); s.set('k', v); }\n",
        'src/backend.ts':
          'export async function load(): Promise<{ set(k: string, v: string): void }> { return { set() {} }; }\n',
        'src/hooks.ts':
          "import { useTabs } from './tabs.js';\nexport function closeAll(): void { useTabs().removeTabs(['a']); }\n",
        'src/tabs.ts':
          'export function useTabs() { return { removeTabs(ids: string[]): void { void ids; } }; }\n',
        'src/pure.ts': 'export function idle(): number { return 1; }\n',
      },
      `
        import { beforeEach, expect, it, vi } from 'vitest';
        import { load } from '../src/backend.js';
        import { save } from '../src/store.js';
        import { closeAll } from '../src/hooks.js';
        import { idle } from '../src/pure.js';
        vi.mock('../src/backend.js');
        const h = vi.hoisted(() => ({ removeTabs: vi.fn(), other: vi.fn() }));
        vi.mock('../src/tabs.js', () => ({ useTabs: () => ({ removeTabs: h.removeTabs }) }));
        const mockStore = { set: vi.fn() };
        beforeEach(() => { vi.mocked(load).mockResolvedValue(mockStore as never); });
        const mockLoad = vi.mocked(load);
        it('alias of a mocked export', async () => {
          await save('x');
          expect(mockLoad).toHaveBeenCalled();
        });
        const plainAlias = load;
        it('plain alias of a mocked export', async () => {
          await save('x');
          expect(plainAlias).toHaveBeenCalled();
        });
        it('alias, code not loading the module', () => {
          idle();
          expect(plainAlias).not.toHaveBeenCalled();
        });
        it('returned object', async () => {
          await save('x');
          expect(mockStore.set).toHaveBeenCalledWith('k', 'x');
        });
        it('returned object, code not loading the module', () => {
          idle();
          expect(mockStore.set).not.toHaveBeenCalled();
        });
        it('factory', () => {
          closeAll();
          expect(h.removeTabs).toHaveBeenCalledWith(['a']);
        });
        it('factory, member not handed over', () => {
          closeAll();
          expect(h.other).not.toHaveBeenCalled();
        });
      `,
    );

    // `vi.mocked(load)` itself counts as a call of `load` whose result the assertion reads.
    expect(byName('alias of a mocked export')).toBe('asserted');
    expect(byName('plain alias of a mocked export')).toBe('reachable');
    expect(byName('alias, code not loading the module')).toBe('none');
    expect(byName('returned object')).toBe('reachable');
    expect(byName('returned object, code not loading the module')).toBe('none');
    expect(byName('factory')).toBe('reachable');
    expect(byName('factory, member not handed over')).toBe('none');
  });

  it('follows a method of an exported object and a default export', () => {
    const byName = asserted(
      {
        'src/api.ts': 'export function send(x: string): void { void x; }\n',
        'src/client.ts':
          "import { send } from './api.js';\nexport const client = { log(m: string): void { send(m); }, idle(): number { return 1; } };\n",
        'src/panel.ts':
          "import { send } from './api.js';\nexport default function panel(): void { send('open'); }\n",
      },
      `
        import { expect, it, vi } from 'vitest';
        import { send } from '../src/api.js';
        import { client } from '../src/client.js';
        import panel from '../src/panel.js';
        vi.mock('../src/api.js');
        it('method', () => { client.log('m'); expect(send).toHaveBeenCalledWith('m'); });
        it('other method', () => { client.idle(); expect(send).not.toHaveBeenCalled(); });
        it('default export', () => { panel(); expect(send).toHaveBeenCalledWith('open'); });
      `,
    );

    expect(byName('method')).toBe('reachable');
    expect(byName('other method')).toBe('none');
    expect(byName('default export')).toBe('reachable');
  });

  it('records no route where project code reachable from the call does not use the global, API or module', () => {
    const byName = asserted(
      {
        'src/math.ts':
          'export function add(a: number, b: number): number { return a + b; }\nexport function setTitle(t: string): void { document.title = t; }\n',
        'src/calc.ts':
          "import { fmt } from './util.js';\nexport function area(r: number): number { return Math.log(r) + r; }\nexport function label(x: number) { return fmt(x); }\n",
        'src/util.ts':
          'export function fmt(x: number): string { return String(x); }\nexport function unrelated(): void { document.body.focus(); }\n',
        'src/widget.ts':
          'const foo = { focus(): number { return 1; } };\nexport function pick(): number { return foo.focus(); }\n',
        'src/api.ts':
          "export function send(x: string): void { void x; }\nexport function get(): string { return 'g'; }\n",
        'src/format.ts':
          "import { send } from './api.js';\nexport function format(x: string): string { return x.trim(); }\nexport function ship(x: string): void { send(x); }\n",
        'src/store.ts':
          'export class Store { fetch(): number { return 1; } }\nexport function count(): number { return new Store().fetch(); }\n',
        'src/flag.ts':
          "declare global { interface Window { analytics?: { track(e: string): void } } }\nexport function maybeTrack(on: boolean): void { if (on) window.analytics?.track('x'); }\n",
        'test/helpers.ts':
          "import { send } from '../src/api.js';\nexport function fill(): void { document.body.innerHTML = '<p>x</p>'; }\nexport function logIt(m: string): void { console.log(m); }\nexport function sendIt(m: string): void { send(m); }\nexport function doFetch(): void { void fetch('u'); }\nexport function track(): void { window.analytics?.track('x'); }\n",
      },
      `
        import { expect, it, vi } from 'vitest';
        import { add } from '../src/math.js';
        import { label, area } from '../src/calc.js';
        import { pick } from '../src/widget.js';
        import { format } from '../src/format.js';
        import { send } from '../src/api.js';
        import { count } from '../src/store.js';
        import { maybeTrack } from '../src/flag.js';
        import { fill, logIt, sendIt, doFetch, track } from './helpers.js';
        vi.mock('../src/api.js');
        it('document in another function of the same file', () => {
          add(1, 2);
          expect(document.body.children.length).toBe(0);
        });
        it('document in an unrelated function of an imported file', () => {
          label(1);
          expect(document.body.children.length).toBe(0);
        });
        it('prototype spy, member of the same name on a plain object', () => {
          const spy = vi.spyOn(HTMLElement.prototype, 'focus');
          pick();
          expect(spy).not.toHaveBeenCalled();
        });
        it('console.log spy, project uses Math.log and a helper logs', () => {
          const spy = vi.spyOn(console, 'log');
          area(2);
          logIt('x');
          expect(spy).toHaveBeenCalledWith('x');
        });
        it('mocked export called by the test', () => {
          format(' a ');
          send('y');
          expect(send).toHaveBeenCalledWith('y');
        });
        it('mocked export called by a test helper', () => {
          format(' a ');
          sendIt('y');
          expect(send).toHaveBeenCalledWith('y');
        });
        it('stubbed fetch, project has a method named fetch and a helper fetches', () => {
          const f = vi.fn();
          vi.stubGlobal('fetch', f);
          count();
          doFetch();
          expect(f).toHaveBeenCalledWith('u');
        });
        it('global read under a branch the test does not take, and by a helper', () => {
          const t = vi.fn();
          window.analytics = { track: t };
          maybeTrack(false);
          track();
          expect(t).toHaveBeenCalled();
        });
        it('page written by a test helper', () => {
          add(1, 2);
          fill();
          expect(document.body.innerHTML).toContain('x');
        });
      `,
    );

    for (const name of [
      'document in another function of the same file',
      'document in an unrelated function of an imported file',
      'prototype spy, member of the same name on a plain object',
      'console.log spy, project uses Math.log and a helper logs',
      'mocked export called by the test',
      'mocked export called by a test helper',
      'stubbed fetch, project has a method named fetch and a helper fetches',
      'global read under a branch the test does not take, and by a helper',
      'page written by a test helper',
    ])
      expect(byName(name), name).toBe('none');
  });
});
