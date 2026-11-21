import { VeritasConfig } from '@under18dev/veritas-core';
import { vitestTestRunner as vitest } from '@under18dev/veritas-test-runner-vitest';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

/** Whether each named test has an asserted project call, for a project and one test file. */
function asserted(files: Record<string, string>, test: string): (name: string) => boolean {
  const root = tempProject({ ...files, 'test/subject.test.ts': test });
  const tests = inventoryTests({
    recognition: vitest.recognition,
    root,
    config: VeritasConfig.parse({}),
  }).tests;

  return (name) => {
    const found = tests.find((candidate) => candidate.name === name);

    if (!found) throw new Error(`missing test: ${name}`);

    return found.targetCalls.some((call) => call.asserted);
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

    expect(byName('after the call')).toBe(true);
    expect(byName('before the call')).toBe(false);
    expect(byName('code without document')).toBe(false);
    expect(byName('what the test wrote')).toBe(false);
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

    expect(byName('prototype spy')).toBe(true);
    expect(byName('document spy')).toBe(true);
    expect(byName('code without the API')).toBe(false);
    expect(byName('self-called spy')).toBe(false);
    expect(byName('read before the call')).toBe(false);
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

    expect(byName('assigned')).toBe(true);
    expect(byName('through a helper')).toBe(true);
    expect(byName('stubbed')).toBe(true);
    expect(byName('code without the global')).toBe(false);
    expect(byName('kept out of the global')).toBe(false);
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

    expect(byName('alias of a mocked export')).toBe(true);
    expect(byName('plain alias of a mocked export')).toBe(true);
    expect(byName('alias, code not loading the module')).toBe(false);
    expect(byName('returned object')).toBe(true);
    expect(byName('returned object, code not loading the module')).toBe(false);
    expect(byName('factory')).toBe(true);
    expect(byName('factory, member not handed over')).toBe(false);
  });
});
