import { VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { inventoryTests } from '../src/index.js';
import { tempProject } from './helpers.js';

// React-style sources without React installed: the analysis reads JSX tags and imports, not React's types.
const project = {
  'src/Dialog.tsx': `export function Dialog(props: { open?: boolean; title?: string; onSave?: () => void; onCancel?: () => void }) {
  return props.open ? <div role="dialog">{props.title}</div> : null;
}
export default Dialog;
`,
  'src/useCounter.ts': `export function useCounter(onChange: (n: number) => void) { onChange(1); return { count: 0 }; }
export function useForm(options: { onSubmit: (value: string) => void }) { return { submit: () => options.onSubmit('x') }; }
`,
  'src/format.ts': 'export const label = (text: string) => text.toUpperCase();\n',
  // Lives under src/, but imports Vitest's runtime: a test utility, not project code.
  'src/test-utils.ts': `import { vi } from 'vitest';
export function asMock<T>(fn: ReturnType<typeof vi.fn>): T { return fn as unknown as T; }
`,
};

const header = `import { render, renderHook, screen, fireEvent, within } from '@testing-library/react';
import { Button } from '@mui/material';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Dialog from '../src/Dialog';
import { useCounter, useForm } from '../src/useCounter';
import { label } from '../src/format';
import { asMock } from '../src/test-utils';
`;

function inventory(testSource: string, extra: Record<string, string> = {}) {
  const root = tempProject({ ...project, 'test/case.test.tsx': testSource, ...extra });
  const result = inventoryTests({ root, config: VeritasConfig.parse({}) });

  return (name: string) => {
    const test = result.tests.find((candidate) => candidate.name === name);

    if (!test) throw new Error(`missing test: ${name}`);

    return {
      symbols: test.calledSymbols,
      asserted: test.targetCalls.some((call) => call.asserted),
      args: test.targetCalls.map((call) => call.args),
      suspicions: test.suspicions,
    };
  };
}

describe('rendered components', () => {
  it('counts a component rendered as JSX as a call, and Testing Library queries as observing it', () => {
    const byName = inventory(`${header}
      it('screen query', () => {
        render(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('query from the render result', () => {
        const { getByText } = render(<Dialog open title="Hi" />);
        expect(getByText('Hi')).toBeTruthy();
      });
      it('within', () => {
        render(<Dialog open title="Hi" />);
        expect(within(screen.getByRole('dialog')).getByText('Hi')).toBeTruthy();
      });
      it('query kept in a local', () => {
        render(<Dialog open title="Hi" />);
        const dialog = screen.getByRole('dialog');
        const heading = dialog.firstChild;
        expect(heading).not.toBeNull();
      });
      it('nested in a third-party element', () => {
        render(<div><Dialog open title="Hi" /></div>);
        expect(screen.queryByText('Hi')).not.toBeNull();
      });
    `);

    for (const name of ['screen query', 'query from the render result', 'within', 'query kept in a local']) {
      expect(byName(name), name).toMatchObject({
        symbols: ['src/Dialog.tsx#Dialog'],
        asserted: true,
        suspicions: [],
      });
      // Props are not positional arguments, so they are not recorded as the component's inputs.
      expect(byName(name).args, name).toEqual([[]]);
    }
    expect(byName('nested in a third-party element').asserted).toBe(true);
  });

  it('follows local render helpers, with or without returning the render result', () => {
    const byName = inventory(`${header}
      describe('Dialog', () => {
        let onSave: ReturnType<typeof vi.fn>;
        let onCancel: ReturnType<typeof vi.fn>;
        beforeEach(() => { onSave = vi.fn(); onCancel = vi.fn(); });
        const renderDialog = (open = true) =>
          render(<Dialog open={open} onSave={asMock<() => void>(onSave)} onCancel={asMock<() => void>(onCancel)} />);
        function mount() { render(<Dialog open onSave={asMock<() => void>(onSave)} />); }
        const props = () => ({ open: true, onSave: asMock<() => void>(onSave) });
        const expectShown = (text: string) => expect(screen.getByText(text)).toBeInTheDocument();

        it('hidden', () => {
          renderDialog(false);
          expect(screen.queryByText('Hi')).not.toBeInTheDocument();
        });
        it('mock through the helper', () => {
          renderDialog();
          fireEvent.click(screen.getByText('save'));
          expect(onSave).toHaveBeenCalledTimes(1);
        });
        it('mock through a helper returning nothing', () => {
          mount();
          expect(onSave).toHaveBeenCalled();
        });
        it('mock calls read into locals', () => {
          renderDialog();
          const calls = onSave.mock.calls;
          const last = calls[calls.length - 1];
          expect(last).toEqual([]);
        });
        it('props from a helper', () => {
          render(<Dialog {...props()} />);
          expect(onSave).toHaveBeenCalled();
        });
        it('asserting helper', () => {
          renderDialog();
          expectShown('Hi');
        });
        it('mock not handed over', () => {
          const other = vi.fn();
          renderDialog();
          other();
          expect(other).toHaveBeenCalled();
        });
        it('mock handed only to an unrelated render', () => {
          mount();
          expect(onCancel).not.toHaveBeenCalled();
        });
        it('constant', () => {
          renderDialog();
          expect(1).toBe(1);
        });
      });
    `);

    for (const name of [
      'hidden',
      'mock through the helper',
      'mock through a helper returning nothing',
      'mock calls read into locals',
      'props from a helper',
      'asserting helper',
    ])
      expect(byName(name), name).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });

    // The mock is never given to project code, or not to the code this test renders.
    for (const name of ['mock not handed over', 'mock handed only to an unrelated render'])
      expect(byName(name), name).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: false });
    expect(byName('constant')).toMatchObject({ asserted: false });
    expect(byName('constant').suspicions).toContain('tautological_assertion');
  });

  it('does not count a screen query when nothing from the project is rendered', () => {
    const byName = inventory(`${header}
      it('third-party only', () => {
        render(<Button>Go</Button>);
        expect(screen.getByRole('button')).toBeInTheDocument();
      });
      it('plain call, then a screen query', () => {
        label('a');
        expect(screen.getByText('A')).toBeInTheDocument();
      });
      it('intrinsic elements only', () => {
        render(<p>text</p>);
        expect(screen.getByText('text')).toBeInTheDocument();
      });
    `);

    expect(byName('third-party only')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('third-party only').suspicions).toContain('target_not_called');
    expect(byName('plain call, then a screen query')).toMatchObject({
      symbols: ['src/format.ts#label'],
      asserted: false,
    });
    expect(byName('intrinsic elements only').suspicions).toContain('target_not_called');
  });

  it('links mocks held in a props object handed to the component, and only assertions on those mocks', () => {
    const byName = inventory(`${header}
      const createProps = () => ({ open: true, title: 'Hi', onSave: vi.fn(), onCancel: asMock<() => void>(vi.fn()) });
      const renderCard = (overrides = {}) => {
        const props = { open: true, onSave: vi.fn(), ...overrides };
        render(<Dialog {...props} />);
        return props;
      };
      describe('props objects', () => {
        let props: ReturnType<typeof createProps>;
        beforeEach(() => { props = createProps(); });

        it('spread props', () => {
          render(<Dialog {...props} />);
          fireEvent.click(screen.getAllByRole('button')[0]);
          expect(props.onSave).toHaveBeenCalled();
        });
        it('local props', () => {
          const local = createProps();
          render(<Dialog {...local} />);
          expect(local.onCancel).toHaveBeenCalledTimes(1);
        });
        it('mock held by an object passed as a prop', () => {
          const editor = { save: vi.fn() };
          const ref = { current: editor };
          render(<Dialog open title={String(ref.current)} onSave={() => ref.current.save()} />);
          const calls = editor.save.mock.calls;
          expect(calls).toHaveLength(1);
        });
        it('props returned by the render helper', () => {
          const shown = renderCard({ title: 'x' });
          expect(shown.onSave).toHaveBeenCalledTimes(1);
        });
        it('value the test set itself', () => {
          render(<Dialog {...props} />);
          expect(props.title).toBe('Hi');
        });
        it('props never handed over', () => {
          const unused = createProps();
          render(<Dialog open />);
          expect(unused.onSave).not.toHaveBeenCalled();
        });
      });
    `);

    for (const name of [
      'spread props',
      'local props',
      'mock held by an object passed as a prop',
      'props returned by the render helper',
    ])
      expect(byName(name), name).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });

    for (const name of ['value the test set itself', 'props never handed over'])
      expect(byName(name), name).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: false });
  });

  it('reads the document through the global document, and mocks a helper returns by name', () => {
    const byName = inventory(`${header}
      function renderCard() {
        const onSave = vi.fn();
        const result = render(<Dialog open onSave={onSave} />);
        return { onSave, result };
      }
      it('document body', () => {
        render(<Dialog open title="Hi" />);
        expect(document.body.textContent).toContain('Hi');
      });
      it('document without a render', () => {
        label('a');
        expect(document.body.textContent).toBe('');
      });
      it('returned by shorthand', () => {
        const { onSave } = renderCard();
        expect(onSave).toHaveBeenCalledWith();
      });
    `);

    expect(byName('document body').asserted).toBe(true);
    expect(byName('document without a render').asserted).toBe(false);
    expect(byName('returned by shorthand')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
  });

  it('counts a local wrapper component as running what it calls', () => {
    const byName = inventory(`${header}
      function Harness() { const { count } = useCounter(() => {}); return <span>{count}</span>; }
      it('harness', () => {
        render(<Harness />);
        expect(screen.getByText('0')).toBeInTheDocument();
      });
    `);

    expect(byName('harness')).toMatchObject({ symbols: ['src/useCounter.ts#useCounter'], asserted: true });
  });

  it('links mocks given to a hook run by renderHook', () => {
    const byName = inventory(`${header}
      describe('hooks', () => {
        let onChange: ReturnType<typeof vi.fn>;
        let onSubmit: ReturnType<typeof vi.fn>;
        beforeEach(() => { onChange = vi.fn(); onSubmit = vi.fn(); });
        const params = () => ({ onSubmit: asMock<(value: string) => void>(onSubmit) });

        it('result', () => {
          const { result } = renderHook(() => useCounter(() => {}));
          expect(result.current.count).toBe(0);
        });
        it('mock argument', () => {
          renderHook(() => useCounter(asMock<(n: number) => void>(onChange)));
          expect(onChange).toHaveBeenCalledWith(1);
        });
        it('mock through a params helper', () => {
          const { result } = renderHook(() => useForm(params()));
          result.current.submit();
          expect(onSubmit).toHaveBeenCalledWith('x');
        });
        it('mock not given to the hook', () => {
          renderHook(() => useForm({ onSubmit: () => {} }));
          expect(onChange).not.toHaveBeenCalled();
        });
        it('initial props', () => {
          const initial = params();
          const { result } = renderHook((props) => useForm(props), { initialProps: initial });
          result.current.submit();
          expect(onSubmit).toHaveBeenCalledTimes(1);
        });
      });
    `);

    expect(byName('result')).toMatchObject({ symbols: ['src/useCounter.ts#useCounter'], asserted: true });
    expect(byName('mock argument')).toMatchObject({
      symbols: ['src/useCounter.ts#useCounter'],
      asserted: true,
    });
    expect(byName('mock through a params helper')).toMatchObject({
      symbols: ['src/useCounter.ts#useForm'],
      asserted: true,
    });
    expect(byName('mock not given to the hook')).toMatchObject({
      symbols: ['src/useCounter.ts#useForm'],
      asserted: false,
    });
    expect(byName('initial props')).toMatchObject({ symbols: ['src/useCounter.ts#useForm'], asserted: true });
  });

  it('treats a file under src/ that imports Vitest’s vi as test code', () => {
    const byName = inventory(`${header}
      it('only the cast', () => {
        const fn = vi.fn();
        const cast = asMock<() => void>(fn);
        cast();
        expect(fn).toHaveBeenCalled();
      });
    `);

    expect(byName('only the cast').symbols).toEqual([]);
    expect(byName('only the cast').asserted).toBe(false);
  });

  it('does not claim a link for a component whose relative import does not resolve', () => {
    const byName = inventory(`${header}
      import Missing from '../src/Missing';
      it('unresolved', () => {
        render(<Missing />);
        expect(screen.getByText('x')).toBeInTheDocument();
      });
    `);

    expect(byName('unresolved').asserted).toBe(false);
    expect(byName('unresolved').suspicions).toContain('unresolved_import');
    expect(byName('unresolved').suspicions).not.toContain('target_not_called');
  });
});

describe('links that are not there', () => {
  it('matches the property of a mock object that was handed over', () => {
    const byName = inventory(`${header}
      it('other member', () => {
        const mocks = { onSave: vi.fn(), track: vi.fn() };
        render(<Dialog onSave={mocks.onSave} />);
        mocks.track();
        expect(mocks.track).toHaveBeenCalled();
      });
      it('same member', () => {
        const mocks = { onSave: vi.fn(), track: vi.fn() };
        render(<Dialog onSave={mocks.onSave} />);
        expect(mocks.onSave).not.toHaveBeenCalled();
      });
      it('only a plain value handed over', () => {
        const props = { title: 'Hi', onSave: vi.fn() };
        render(<Dialog title={props.title} />);
        expect(props.onSave).not.toHaveBeenCalled();
      });
    `);

    expect(byName('other member').asserted).toBe(false);
    expect(byName('same member').asserted).toBe(true);
    expect(byName('only a plain value handed over').asserted).toBe(false);
  });

  it('counts JSX as a call only once it is mounted', () => {
    const byName = inventory(`${header}
      import { isValidElement } from 'react';
      it('element compared', () => { expect(<Dialog open />).toBeTruthy(); });
      it('element checked', () => { expect(isValidElement(<Dialog open />)).toBe(true); });
      it('element props', () => { const element = <Dialog open />; expect(element.props.open).toBe(true); });
      it('created, another rendered', () => {
        const unused = <Dialog />;
        render(<p>Hi</p>);
        expect(screen.getByText('Hi')).toBeTruthy();
      });
      it('kept in a local, then rendered', () => {
        const ui = <Dialog open title="Hi" />;
        render(ui);
        expect(screen.getByText('Hi')).toBeTruthy();
      });
    `);

    for (const name of ['element compared', 'element checked', 'element props', 'created, another rendered'])
      expect(byName(name), name).toMatchObject({ symbols: [], asserted: false });
    expect(byName('kept in a local, then rendered')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
  });

  it('does not credit a wrapper with a page query that may only find the children the test supplied', () => {
    const byName = inventory(
      `${header}
      import { Providers } from '../src/Providers';
      const renderWithProviders = (ui: JSX.Element) => render(<Providers>{ui}</Providers>);
      it('third-party child', () => {
        render(<Providers><Button>Go</Button></Providers>);
        expect(screen.getByText('Go')).toBeInTheDocument();
      });
      it('through a provider helper', () => {
        renderWithProviders(<Button>Go</Button>);
        expect(screen.getByText('Go')).toBeInTheDocument();
      });
      it('project child', () => {
        render(<Providers><Dialog open title="Hi" /></Providers>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
    `,
      {
        'src/Providers.tsx':
          'export function Providers(props: { children?: unknown }) { return props.children; }\n',
      },
    );

    expect(byName('third-party child')).toMatchObject({
      symbols: ['src/Providers.tsx#Providers'],
      asserted: false,
    });
    expect(byName('through a provider helper')).toMatchObject({
      symbols: ['src/Providers.tsx#Providers'],
      asserted: false,
    });
    expect(byName('project child').asserted).toBe(true);
  });

  it('skips page reads made before the render or of what the test wrote, and mocks the test calls itself', () => {
    const byName = inventory(`${header}
      it('read before the render', () => {
        const before = screen.queryByText('Hi');
        render(<Dialog open title="Hi" />);
        expect(before).toBeNull();
      });
      it('value the test wrote', () => {
        document.body.className = 'dark';
        render(<Dialog open />);
        expect(document.body.className).toBe('dark');
      });
      it('mock called by the test', () => {
        const onSave = vi.fn();
        render(<Dialog onSave={onSave} />);
        onSave();
        expect(onSave).toHaveBeenCalled();
      });
    `);

    for (const name of ['read before the render', 'value the test wrote', 'mock called by the test'])
      expect(byName(name), name).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: false });
  });
});

describe('links that are not there, continued', () => {
  it('keeps which returned property of a helper carries what it handed over', () => {
    const byName = inventory(`${header}
      function setup() {
        const used = vi.fn();
        const unused = vi.fn();
        render(<Dialog onSave={used} />);
        return { used, unused };
      }
      it('unused member', () => { expect(setup().unused).not.toHaveBeenCalled(); });
      it('unused member destructured', () => {
        const { unused } = setup();
        expect(unused).not.toHaveBeenCalled();
      });
      it('used member', () => {
        const { used } = setup();
        expect(used).not.toHaveBeenCalled();
      });
      it('used member through a local', () => {
        const mocks = setup();
        expect(mocks.used).not.toHaveBeenCalled();
      });
    `);

    expect(byName('unused member').asserted).toBe(false);
    expect(byName('unused member destructured').asserted).toBe(false);
    expect(byName('used member').asserted).toBe(true);
    expect(byName('used member through a local').asserted).toBe(true);
  });

  it('counts a query in a function only when the function runs', () => {
    const byName = inventory(`${header}
      import { waitFor } from '@testing-library/react';
      it('function compared', () => {
        render(<Dialog open title="Hi" />);
        expect(() => screen.getByText('Hi')).toBeTruthy();
      });
      it('function run by a throw matcher', () => {
        render(<Dialog open title="Hi" />);
        expect(() => screen.getByText('Hi')).not.toThrow();
      });
      it('local function called', () => {
        const read = () => screen.getByText('Hi');
        render(<Dialog open title="Hi" />);
        expect(read()).toBeTruthy();
      });
      it('run by waitFor', async () => {
        render(<Dialog open title="Hi" />);
        expect(await waitFor(() => screen.getByText('Hi'))).toBeTruthy();
      });
    `);

    expect(byName('function compared').asserted).toBe(false);
    expect(byName('function run by a throw matcher').asserted).toBe(true);
    expect(byName('local function called').asserted).toBe(true);
    expect(byName('run by waitFor').asserted).toBe(true);
  });

  it('runs server-rendered components without linking reads of the document to them', () => {
    const byName = inventory(`${header}
      import { renderToString } from 'react-dom/server';
      it('document after server rendering', () => {
        renderToString(<Dialog open title="Hi" />);
        expect(document.body.textContent).toBe('');
      });
      it('returned HTML', () => {
        const html = renderToString(<Dialog open title="Hi" />);
        expect(html).toContain('Hi');
      });
    `);

    expect(byName('document after server rendering')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: false,
    });
    expect(byName('returned HTML').asserted).toBe(true);
  });

  it('treats content the test puts into the page itself as written by the test', () => {
    const byName = inventory(`${header}
      it('inner HTML', () => {
        document.body.innerHTML = '<p>Hi</p>';
        render(<Dialog open />);
        expect(document.body.textContent).toContain('Hi');
      });
      it('appended node', () => {
        const node = document.createElement('p');
        document.body.appendChild(node);
        render(<Dialog open />);
        expect(document.body.lastChild).toBe(node);
      });
    `);

    expect(byName('inner HTML').asserted).toBe(false);
    expect(byName('appended node').asserted).toBe(false);
  });
});

describe('links that are not there, third pass', () => {
  it('does not count mock state the test produced itself', () => {
    const byName = inventory(`${header}
      it('mock calls compared', () => {
        const onSave = vi.fn();
        render(<Dialog onSave={onSave} />);
        onSave('test');
        expect(onSave.mock.calls).toEqual([['test']]);
      });
      it('mock calls kept in a local', () => {
        const onSave = vi.fn();
        render(<Dialog onSave={onSave} />);
        onSave('test');
        const calls = onSave.mock.calls;
        expect(calls).toHaveLength(1);
      });
    `);

    expect(byName('mock calls compared').asserted).toBe(false);
    expect(byName('mock calls kept in a local').asserted).toBe(false);
  });

  it('credits a local component only with what reaches its output', () => {
    const byName = inventory(`${header}
      function Harness() { label('ignored'); return <p>Hi</p>; }
      it('discarded call', () => {
        render(<Harness />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
    `);

    expect(byName('discarded call')).toMatchObject({ symbols: ['src/format.ts#label'], asserted: false });
  });

  it('counts only queries run on what within returns', () => {
    const byName = inventory(`${header}
      it('within alone', () => {
        render(<Dialog open title="Hi" />);
        expect(within(document.createElement('div'))).toBeTruthy();
      });
      it('within kept in a local, then queried', () => {
        render(<Dialog open title="Hi" />);
        const dialog = within(screen.getByRole('dialog'));
        expect(dialog.getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('within alone').asserted).toBe(false);
    expect(byName('within kept in a local, then queried').asserted).toBe(true);
  });

  it('does not credit any later read of the page after the test put content into it', () => {
    const byName = inventory(`${header}
      it('screen after appended content', () => {
        const node = document.createElement('p');
        node.textContent = 'Hi';
        document.body.appendChild(node);
        render(<Dialog open />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('text query after an empty anchor', () => {
        const anchor = document.createElement('button');
        document.body.appendChild(anchor);
        render(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('role query after an empty anchor', () => {
        const anchor = document.createElement('button');
        document.body.appendChild(anchor);
        render(<Dialog open title="Hi" />);
        expect(screen.getByRole('button')).toBeInTheDocument();
      });
      it('query selector after inner HTML', () => {
        document.documentElement.innerHTML = '<p class="x">Hi</p>';
        render(<Dialog open />);
        expect(document.querySelector('.x')).not.toBeNull();
      });
    `);

    expect(byName('screen after appended content').asserted).toBe(false);
    expect(byName('query selector after inner HTML').asserted).toBe(false);
    // An element the test created and left empty: no text query can find it, a role query can.
    expect(byName('text query after an empty anchor').asserted).toBe(true);
    expect(byName('role query after an empty anchor').asserted).toBe(false);
  });

  it('leaves calls that do not reach a helper result out of the keys it carries', () => {
    const byName = inventory(
      `${header}
      import { compute } from '../src/compute';
      const calc = () => {
        const a = compute(2);
        compute(3);
        return { used: a, unused: 1 };
      };
      it('unused key', () => { expect(calc().unused).toBe(1); });
      it('used key', () => { expect(calc().used).toBe(3); });
    `,
      { 'src/compute.ts': 'export const compute = (n: number) => n + 1;\n' },
    );

    expect(byName('unused key').asserted).toBe(false);
    expect(byName('used key').asserted).toBe(true);
  });
});

describe('links found in more places', () => {
  it('recognizes an aliased render and renders in setup hooks that run before the test', () => {
    const byName = inventory(`${header}
      import { render as rtlRender } from '@testing-library/react';
      it('aliased render', () => {
        rtlRender(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      describe('rendered in beforeEach', () => {
        beforeEach(() => { render(<Dialog open title="Hi" />); });
        it('shown', () => { expect(screen.getByText('Hi')).toBeInTheDocument(); });
      });
      describe('another describe', () => {
        it('not rendered here', () => { expect(screen.queryByText('Hi')).toBeNull(); });
      });
    `);

    expect(byName('aliased render')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    expect(byName('shown')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    expect(byName('not rendered here')).toMatchObject({ symbols: [], asserted: false });
  });
});

describe('renders in shared setup', () => {
  it('counts only mounting calls that run in a beforeEach hook', () => {
    const byName = inventory(`${header}
      const ui = <Dialog open title="Hi" />;
      it('module A', () => { render(ui); expect(screen.getByText('Hi')).toBeTruthy(); });
      it('module B', () => { render(<Button>Go</Button>); expect(screen.getByText('Go')).toBeTruthy(); });
      describe('stored in a describe', () => {
        const local = <Dialog open title="Hi" />;
        it('describe A', () => { render(local); expect(screen.getByText('Hi')).toBeTruthy(); });
        it('describe B', () => { render(<Button>Go</Button>); expect(screen.getByText('Go')).toBeTruthy(); });
      });
      describe('rendered in beforeEach from a stored element', () => {
        const element = <Dialog open title="Hi" />;
        beforeEach(() => { render(element); });
        it('each', () => { expect(screen.getByText('Hi')).toBeTruthy(); });
      });
      describe('rendered in beforeAll', () => {
        beforeAll(() => { render(<Dialog open title="Hi" />); });
        it('first', () => { expect(screen.getByText('Hi')).toBeTruthy(); });
      });
    `);

    expect(byName('module A').asserted).toBe(true);
    expect(byName('module B')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('describe A').asserted).toBe(true);
    expect(byName('describe B')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('each')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    // Testing Library cleans the page up after each test, so a beforeAll render is left out.
    expect(byName('first')).toMatchObject({ symbols: [], asserted: false });
  });
});

describe('ordering, running and provenance of page reads', () => {
  it('orders reads by where an element is mounted, not where it is made', () => {
    const byName = inventory(`${header}
      it('read before the mount', () => {
        const ui = <Dialog open title="Hi" />;
        const before = screen.queryByText('Hi');
        render(ui);
        expect(before).toBeNull();
      });
      it('read after the mount', () => {
        const ui = <Dialog open title="Hi" />;
        render(ui);
        const after = screen.queryByText('Hi');
        expect(after).not.toBeNull();
      });
    `);

    expect(byName('read before the mount').asserted).toBe(false);
    expect(byName('read after the mount').asserted).toBe(true);
  });

  it('counts JSX returned by a function only when the function runs', () => {
    const byName = inventory(`${header}
      it('function never called', () => {
        function unused() { return <Dialog open />; }
        render(<p>Hi</p>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('factory called', () => {
        const make = () => <Dialog open title="Hi" />;
        render(make());
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
    `);

    expect(byName('function never called')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('factory called')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    // Recorded once, at the call, not also where the factory is written.
    expect(byName('factory called').args).toEqual([[]]);
  });

  it('credits a within query only when its container comes from the rendered page', () => {
    const byName = inventory(`${header}
      it('detached container', () => {
        render(<Dialog open title="Hi" />);
        expect(within(document.createElement('div')).queryByText('Hi')).toBeNull();
      });
      it('container from the render result', () => {
        const { container } = render(<Dialog open title="Hi" />);
        expect(within(container).getByText('Hi')).toBeTruthy();
      });
      it('container from the document', () => {
        render(<Dialog open title="Hi" />);
        expect(within(document.body).getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('detached container').asserted).toBe(false);
    expect(byName('container from the render result').asserted).toBe(true);
    expect(byName('container from the document').asserted).toBe(true);
  });

  it('follows a query helper written as a function declaration', () => {
    const byName = inventory(`${header}
      function query() { return screen.queryByText('Hi'); }
      it('declared helper', () => {
        render(<Dialog open title="Hi" />);
        expect(query()).toBeTruthy();
      });
      it('declared helper not called', () => {
        render(<Dialog open title="Hi" />);
        expect(query).toBeTruthy();
      });
    `);

    expect(byName('declared helper').asserted).toBe(true);
    expect(byName('declared helper not called').asserted).toBe(false);
  });
});

describe('reaching a renderer and the page', () => {
  it('follows an element given to a helper into the renderer it reaches', () => {
    const byName = inventory(`${header}
      import { isValidElement } from 'react';
      const check = (element: unknown) => isValidElement(element);
      const show = (element: JSX.Element) => render(<div>{element}</div>);
      it('helper that only inspects', () => { expect(check(<Dialog open />)).toBe(true); });
      it('helper that renders', () => {
        show(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('helper that only inspects')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('helper that renders')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
  });

  it('links renderers outside the page only to their own output', () => {
    const byName = inventory(`${header}
      import { create } from 'react-test-renderer';
      import { shallow } from 'enzyme';
      it('test renderer, then the document', () => {
        create(<Dialog open title="Hi" />);
        expect(document.body.textContent).toBe('');
      });
      it('test renderer output', () => {
        const tree = create(<Dialog open title="Hi" />);
        expect(tree.toJSON()).toBeTruthy();
      });
      it('enzyme, then the screen', () => {
        shallow(<Dialog open title="Hi" />);
        expect(screen.queryByText('Hi')).toBeNull();
      });
    `);

    expect(byName('test renderer, then the document')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: false,
    });
    expect(byName('test renderer output').asserted).toBe(true);
    expect(byName('enzyme, then the screen').asserted).toBe(false);
  });

  it('resolves JSX attribute precedence before counting what was handed over', () => {
    const byName = inventory(`${header}
      describe('helper with overrides', () => {
        const onSave = vi.fn();
        const renderWith = (overrides = {}) => render(<Dialog onSave={onSave} {...overrides} />);
        it('overrides from callers without it', () => {
          renderWith({ title: 'Hi' });
          expect(onSave).not.toHaveBeenCalled();
        });
      });
      describe('helper whose caller replaces the mock', () => {
        const onCancel = vi.fn();
        const renderOther = (overrides = {}) => render(<Dialog onCancel={onCancel} {...overrides} />);
        it('overrides from a caller with it', () => {
          renderOther({ onCancel: undefined });
          expect(onCancel).not.toHaveBeenCalled();
        });
      });
      it('spread overridden by a later attribute', () => {
        const props = { onSave: vi.fn() };
        render(<Dialog {...props} onSave={undefined} />);
        expect(props.onSave).not.toHaveBeenCalled();
      });
      it('attribute overridden by a later spread', () => {
        const onSave = vi.fn();
        const rest = { onSave: () => {} };
        render(<Dialog onSave={onSave} {...rest} />);
        expect(onSave).not.toHaveBeenCalled();
      });
      it('spread with another attribute after it', () => {
        const props = { onSave: vi.fn() };
        render(<Dialog {...props} title="Hi" />);
        expect(props.onSave).not.toHaveBeenCalled();
      });
      it('attribute after a spread without it', () => {
        const onSave = vi.fn();
        const rest = { title: 'Hi' };
        render(<Dialog onSave={onSave} {...rest} />);
        expect(onSave).not.toHaveBeenCalled();
      });
    `);

    expect(byName('overrides from callers without it').asserted).toBe(true);
    expect(byName('overrides from a caller with it').asserted).toBe(false);
    expect(byName('spread overridden by a later attribute').asserted).toBe(false);
    expect(byName('attribute overridden by a later spread').asserted).toBe(false);
    expect(byName('spread with another attribute after it').asserted).toBe(true);
    expect(byName('attribute after a spread without it').asserted).toBe(true);
  });

  it('follows locals holding part of the document when finding what the test wrote', () => {
    const byName = inventory(`${header}
      it('alias of the body', () => {
        const body = document.body;
        body.innerHTML = '<p>Hi</p>';
        render(<Dialog open />);
        expect(screen.getByText('Hi')).toBeTruthy();
      });
      it('destructured body', () => {
        const { body } = document;
        body.appendChild(document.createTextNode('Hi'));
        render(<Dialog open />);
        expect(screen.getByText('Hi')).toBeTruthy();
      });
      it('alias only read', () => {
        const body = document.body;
        render(<Dialog open title="Hi" />);
        expect(body.textContent).toContain('Hi');
      });
    `);

    expect(byName('alias of the body').asserted).toBe(false);
    expect(byName('destructured body').asserted).toBe(false);
    // The local holds the live body, read where it is used: after the render.
    expect(byName('alias only read').asserted).toBe(true);
  });
});

describe('reads that run, containers and renderer names', () => {
  it('counts a mock read inside a function only when the function runs', () => {
    const byName = inventory(`${header}
      it('mock state in a function compared', () => {
        const onSave = vi.fn();
        render(<Dialog onSave={onSave} />);
        expect(() => onSave.mock.calls).toBeTruthy();
      });
      it('mock in a function compared', () => {
        const onSave = vi.fn();
        render(<Dialog onSave={onSave} />);
        expect(() => onSave).toBeTruthy();
      });
      it('mock state read by a called local function', () => {
        const onSave = vi.fn();
        const calls = () => onSave.mock.calls;
        render(<Dialog onSave={onSave} />);
        expect(calls()).toEqual([]);
      });
    `);

    expect(byName('mock state in a function compared').asserted).toBe(false);
    expect(byName('mock in a function compared').asserted).toBe(false);
    expect(byName('mock state read by a called local function').asserted).toBe(true);
  });

  it('follows what a local function returns when judging a within container', () => {
    const byName = inventory(`${header}
      const detached = () => document.createElement('div');
      const dialog = () => screen.getByRole('dialog');
      it('detached through a helper', () => {
        render(<Dialog open title="Hi" />);
        expect(within(detached()).queryByText('Hi')).toBeNull();
      });
      it('page element through a helper', () => {
        render(<Dialog open title="Hi" />);
        expect(within(dialog()).getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('detached through a helper').asserted).toBe(false);
    expect(byName('page element through a helper').asserted).toBe(true);
  });

  it('takes mount, shallow and create as outside renderers only from their packages', () => {
    const byName = inventory(`${header}
      import { mount as enzymeMount } from 'enzyme';
      function mount(element: JSX.Element) { return render(element); }
      it('local helper named mount', () => {
        mount(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeTruthy();
      });
      it('enzyme mount', () => {
        enzymeMount(<Dialog open title="Hi" />);
        expect(screen.queryByText('Hi')).toBeNull();
      });
    `);

    expect(byName('local helper named mount')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
    expect(byName('enzyme mount')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: false });
  });
});

describe('callbacks in plain unit tests', () => {
  it('counts calls in callbacks given to array and Promise methods as run', () => {
    const root = tempProject({
      'src/plain.ts': `export const compute = (n: number) => n * 2;
export const isValid = (s: string) => s.length > 0;
export const load = async (n: number) => n;
`,
      'test/plain.test.ts': `import { expect, it } from 'vitest';
import { compute, isValid, load } from '../src/plain';
it('map', () => { expect([1, 2].map((n) => compute(n))).toEqual([2, 4]); });
it('filter', () => { expect(['', 'a'].filter((s) => isValid(s))).toEqual(['a']); });
it('every', () => { expect(['a', 'b'].every((s) => isValid(s))).toBe(true); });
it('promise all', async () => { expect(await Promise.all([1, 2].map((n) => load(n)))).toEqual([1, 2]); });
it('function compared', () => { expect(() => compute(1)).toBeTruthy(); });
it('function thrown', () => { expect(() => compute(1)).not.toThrow(); });
`,
    });
    const tests = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests;
    const asserted = (name: string) =>
      tests.find((test) => test.name === name)?.targetCalls.some((call) => call.asserted);

    for (const name of ['map', 'filter', 'every', 'promise all', 'function thrown'])
      expect(asserted(name), name).toBe(true);
    expect(asserted('function compared')).toBe(false);
  });
});

describe('props, setup hand-offs, writes that run and namespaces', () => {
  it('counts an element given as a prop only when the component renders that prop', () => {
    const byName = inventory(`${header}
      function Ignore({ unused }: { unused: JSX.Element }) { return <p>Hi</p>; }
      function Layout({ header }: { header: JSX.Element }) { return <main>{header}</main>; }
      function Shell(props: { body: JSX.Element }) { return <div>{props.body}</div>; }
      it('prop ignored', () => {
        render(<Ignore unused={<Dialog open title="Hi" />} />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('prop rendered', () => {
        render(<Layout header={<Dialog open title="Hi" />} />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('prop rendered through props', () => {
        render(<Shell body={<Dialog open title="Hi" />} />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('prop of a third-party component', () => {
        render(<Button startIcon={<Dialog open title="Hi" />}>Go</Button>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
    `);

    expect(byName('prop ignored')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('prop rendered')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    expect(byName('prop rendered through props')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
    expect(byName('prop of a third-party component')).toMatchObject({ symbols: [], asserted: false });
  });

  it('links the mocks a beforeEach render was handed', () => {
    const byName = inventory(`${header}
      describe('setup', () => {
        const props = { open: true, onSave: vi.fn(), onCancel: vi.fn() };
        beforeEach(() => { render(<Dialog onSave={props.onSave} open />); });
        it('handed mock', () => {
          fireEvent.click(screen.getByText('save'));
          expect(props.onSave).toHaveBeenCalled();
        });
        it('mock not handed', () => { expect(props.onCancel).not.toHaveBeenCalled(); });
      });
    `);

    expect(byName('handed mock')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    expect(byName('mock not handed')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: false });
  });

  it('counts a write to the page only when its code runs', () => {
    const byName = inventory(`${header}
      it('write in a function never called', () => {
        const reset = () => { document.body.innerHTML = ''; };
        render(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('write in a function called', () => {
        const fill = () => { document.body.innerHTML = '<p>Hi</p>'; };
        fill();
        render(<Dialog open />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('listener that never fires', () => {
        window.addEventListener('message', () => { document.body.innerHTML = '<p>Hi</p>'; });
        render(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('listener with events fired', () => {
        window.addEventListener('click', () => { document.body.innerHTML = '<p>Hi</p>'; });
        render(<Dialog open />);
        fireEvent.click(document.body);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
    `);

    expect(byName('write in a function never called').asserted).toBe(true);
    expect(byName('write in a function called').asserted).toBe(false);
    expect(byName('listener that never fires').asserted).toBe(true);
    expect(byName('listener with events fired').asserted).toBe(false);
  });

  it('resolves Testing Library namespace imports', () => {
    const byName = inventory(`${header}
      import * as rtl from '@testing-library/react';
      it('namespace screen', () => {
        rtl.render(<Dialog open title="Hi" />);
        expect(rtl.screen.getByText('Hi')).toBeTruthy();
      });
      it('namespace within', () => {
        rtl.render(<Dialog open title="Hi" />);
        expect(rtl.within(rtl.screen.getByRole('dialog')).getByText('Hi')).toBeTruthy();
      });
      it('namespace screen without a project render', () => {
        rtl.render(<p>Hi</p>);
        expect(rtl.screen.getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('namespace screen').asserted).toBe(true);
    expect(byName('namespace within').asserted).toBe(true);
    expect(byName('namespace screen without a project render')).toMatchObject({
      symbols: [],
      asserted: false,
    });
  });
});

describe('children, scopes, descriptors and setup writes', () => {
  it('counts children only when the receiving component renders them', () => {
    const byName = inventory(`${header}
      function Ignore({ children }: { children?: unknown }) { return <p>Hi</p>; }
      function Frame({ children }: { children?: unknown }) { return <section>{children}</section>; }
      it('children ignored', () => {
        render(<Ignore><Dialog open title="Hi" /></Ignore>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('children rendered', () => {
        render(<Frame><Dialog open title="Hi" /></Frame>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
    `);

    expect(byName('children ignored')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('children rendered')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
  });

  it('scopes a stored element mounted in a hook to the describe of that hook', () => {
    const byName = inventory(`${header}
      const ui = <Dialog open title="Hi" />;
      describe('A', () => {
        beforeEach(() => { render(ui); });
        it('in A', () => { expect(screen.getByText('Hi')).toBeInTheDocument(); });
      });
      describe('B', () => {
        it('in B', () => { expect(screen.queryByText('Hi')).toBeNull(); });
      });
    `);

    expect(byName('in A')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    expect(byName('in B')).toMatchObject({ symbols: [], asserted: false });
  });

  it('counts document query methods only when called', () => {
    const byName = inventory(`${header}
      it('method as a value', () => {
        render(<Dialog open title="Hi" />);
        expect(document.querySelector).toBeTypeOf('function');
      });
      it('method kept in a local', () => {
        render(<Dialog open title="Hi" />);
        const query = document.querySelector;
        expect(query).toBeDefined();
      });
      it('method called', () => {
        render(<Dialog open title="Hi" />);
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      });
    `);

    expect(byName('method as a value').asserted).toBe(false);
    expect(byName('method kept in a local').asserted).toBe(false);
    expect(byName('method called').asserted).toBe(true);
  });

  it('leaves out only what a self-called mock says, not other project results in the assertion', () => {
    const byName = inventory(`${header}
      it('project result against a self-called mock', () => {
        const expected = vi.fn();
        expected('A');
        expect(label('a')).toBe(expected.mock.calls[0][0]);
      });
      it('self-called mock alone', () => {
        const onSave = vi.fn();
        render(<Dialog onSave={onSave} />);
        onSave();
        expect(onSave.mock.calls).toHaveLength(1);
      });
    `);

    expect(byName('project result against a self-called mock').asserted).toBe(true);
    expect(byName('self-called mock alone').asserted).toBe(false);
  });

  it('does not take the element description as what the component rendered', () => {
    const byName = inventory(`${header}
      it('descriptor props', () => {
        const ui = <Dialog open title="Hi" />;
        render(ui);
        expect(ui.props.title).toBe('Hi');
      });
      it('render result of a stored element', () => {
        const ui = <Dialog open title="Hi" />;
        const { getByText } = render(ui);
        expect(getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('descriptor props')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: false });
    expect(byName('render result of a stored element').asserted).toBe(true);
  });

  it('follows a destructured mock back to the object it came from', () => {
    const byName = inventory(`${header}
      it('destructured mock handed over', () => {
        const props = { onSave: vi.fn(), onCancel: vi.fn() };
        const { onSave } = props;
        render(<Dialog onSave={onSave} />);
        expect(onSave).not.toHaveBeenCalled();
      });
      it('other member asserted', () => {
        const props = { onSave: vi.fn(), onCancel: vi.fn() };
        const { onSave } = props;
        render(<Dialog onSave={onSave} />);
        expect(props.onCancel).not.toHaveBeenCalled();
      });
    `);

    expect(byName('destructured mock handed over').asserted).toBe(true);
    expect(byName('other member asserted').asserted).toBe(false);
  });

  it('counts page writes made by shared setup before the test', () => {
    const byName = inventory(`${header}
      describe('fixture written in setup', () => {
        beforeEach(() => {
          document.body.innerHTML = '<p>fixture</p>';
          render(<Dialog open title="Hi" />);
        });
        it('reads the fixture', () => { expect(screen.getByText('fixture')).toBeInTheDocument(); });
      });
      describe('no writes in setup', () => {
        beforeEach(() => { render(<Dialog open title="Hi" />); });
        it('reads the dialog', () => { expect(screen.getByText('Hi')).toBeInTheDocument(); });
      });
    `);

    expect(byName('reads the fixture')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: false,
    });
    expect(byName('reads the dialog')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
  });
});

describe('wrappers from project files', () => {
  it('mounts what a project wrapper renders exactly when the wrapper element in the test is mounted', () => {
    const byName = inventory(
      `${header}
      import { Section } from '../src/Section';
      import { Layout } from '../src/Layout';
      const Wrapper = ({ children }: { children?: unknown }) => <Section>{children}</Section>;
      function Ignore({ children }: { children?: unknown }) { return <p>Hi</p>; }
      it('project provider around the component', () => {
        render(<Section><Dialog open title="Hi" /></Section>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('local wrapper around a project provider', () => {
        render(<Wrapper><Dialog open title="Hi" /></Wrapper>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('project component inside the component children', () => {
        render(<Dialog open><Section>x</Section></Dialog>);
        expect(screen.getByText('x')).toBeInTheDocument();
      });
      it('project layout header', () => {
        render(<Layout header={<Dialog open title="Hi" />} />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('wrapper that ignores its children', () => {
        render(<Ignore><Dialog open title="Hi" /></Ignore>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('project provider only created', () => {
        const element = <Section><Dialog open title="Hi" /></Section>;
        expect(element).toBeTruthy();
      });
    `,
      {
        'src/Section.tsx':
          'export const Section = ({ children }: { children?: unknown }) => <section>{children}</section>;\n',
        'src/Layout.tsx':
          'export function Layout({ header }: { header: unknown }) { return <main>{header}</main>; }\n',
        'src/Dialog.tsx': `export function Dialog(props: { open?: boolean; title?: string; children?: unknown; onSave?: () => void }) {
  return props.open ? <div role="dialog">{props.title}{props.children}</div> : null;
}
export default Dialog;
`,
      },
    );

    expect(byName('project provider around the component')).toMatchObject({
      symbols: ['src/Section.tsx#Section', 'src/Dialog.tsx#Dialog'],
      asserted: true,
    });
    expect(byName('local wrapper around a project provider').symbols).toContain('src/Dialog.tsx#Dialog');
    expect(byName('local wrapper around a project provider').asserted).toBe(true);
    expect(byName('project component inside the component children').symbols).toEqual([
      'src/Dialog.tsx#Dialog',
      'src/Section.tsx#Section',
    ]);
    expect(byName('project layout header').symbols).toContain('src/Dialog.tsx#Dialog');
    expect(byName('project layout header').asserted).toBe(true);
    expect(byName('wrapper that ignores its children')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('project provider only created')).toMatchObject({ symbols: [], asserted: false });
  });
});

describe('mounts that run, helper positions, spread overrides and event handlers', () => {
  it('counts a render only when the function holding it runs', () => {
    const byName = inventory(`${header}
      it('render in an uncalled function', () => {
        function unused() { render(<Dialog open title="Hi" />); }
        expect(document.body.textContent).toBe('');
      });
      it('render in a called function', () => {
        function show() { render(<Dialog open title="Hi" />); }
        show();
        expect(document.body.textContent).toContain('Hi');
      });
    `);

    expect(byName('render in an uncalled function')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('render in a called function')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
  });

  it('places a query helper read where the helper is called', () => {
    const byName = inventory(`${header}
      function query() { return screen.queryByText('Hi'); }
      const read = () => screen.queryByText('Hi');
      it('declared helper called before the render', () => {
        const before = query();
        render(<Dialog open title="Hi" />);
        expect(before).toBeNull();
      });
      it('arrow helper called before the render', () => {
        const before = read();
        render(<Dialog open title="Hi" />);
        expect(before).toBeNull();
      });
      it('helper called after the render', () => {
        render(<Dialog open title="Hi" />);
        const after = query();
        expect(after).not.toBeNull();
      });
    `);

    expect(byName('declared helper called before the render').asserted).toBe(false);
    expect(byName('arrow helper called before the render').asserted).toBe(false);
    expect(byName('helper called after the render').asserted).toBe(true);
  });

  it('lets a later spread replace members of an earlier one', () => {
    const byName = inventory(`${header}
      it('later literal spread', () => {
        const props = { onSave: vi.fn() };
        render(<Dialog {...props} {...{ onSave: undefined }} />);
        expect(props.onSave).not.toHaveBeenCalled();
      });
      it('later spread of an unknown value', () => {
        const props = { onSave: vi.fn() };
        render(<Dialog {...props} {...Object.create(null)} />);
        expect(props.onSave).not.toHaveBeenCalled();
      });
      it('later spread without the member', () => {
        const props = { onSave: vi.fn() };
        render(<Dialog {...props} {...{ title: 'Hi' }} />);
        expect(props.onSave).not.toHaveBeenCalled();
      });
    `);

    expect(byName('later literal spread').asserted).toBe(false);
    expect(byName('later spread of an unknown value').asserted).toBe(false);
    expect(byName('later spread without the member').asserted).toBe(true);
  });

  it('counts an event handler on a DOM element as run only when the test fires events', () => {
    const byName = inventory(
      `${header}
      import { handleClick } from '../src/handlers';
      it('handler registered', () => {
        const { getByText } = render(<button onClick={handleClick}>Hi</button>);
        expect(getByText('Hi')).toBeTruthy();
      });
      it('handler fired', () => {
        const { getByText } = render(<button onClick={handleClick}>Hi</button>);
        fireEvent.click(getByText('Hi'));
        expect(getByText('Hi')).toBeTruthy();
      });
    `,
      { 'src/handlers.ts': 'export function handleClick() { return 1; }\n' },
    );

    expect(byName('handler registered')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('handler fired').symbols).toEqual(['src/handlers.ts#handleClick']);
  });
});

describe('render helpers from a shared utils file', () => {
  it('follows exported render helpers in every export form', () => {
    const byName = inventory(
      `${header}
      import { renderArrow, renderDeclared, renderAliased, renderWithFrame } from './utils';
      it('exported arrow', () => {
        renderArrow(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('exported declaration', () => {
        renderDeclared(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('export specifier', () => {
        renderAliased(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('exported provider helper', () => {
        renderWithFrame(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('render in an uncalled local function', () => {
        function unused() { render(<Dialog open title="Hi" />); }
        expect(document.body.textContent).toBe('');
      });
    `,
      {
        'test/utils.tsx': `import { render } from '@testing-library/react';
import { Frame } from '../src/Frame';
export const renderArrow = (ui: JSX.Element) => render(ui);
export function renderDeclared(ui: JSX.Element) { return render(ui); }
const plain = (ui: JSX.Element) => render(ui);
export { plain as renderAliased };
export function renderWithFrame(ui: JSX.Element) { return render(<Frame>{ui}</Frame>); }
`,
        'src/Frame.tsx':
          'export const Frame = ({ children }: { children?: unknown }) => <section>{children}</section>;\n',
        // A .tsx module is resolved by name only with a JSX setting.
        'tsconfig.json': JSON.stringify({
          compilerOptions: { jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler' },
        }),
      },
    );

    for (const name of [
      'exported arrow',
      'exported declaration',
      'export specifier',
      'exported provider helper',
    ]) {
      expect(byName(name).symbols, name).toContain('src/Dialog.tsx#Dialog');
      expect(byName(name).asserted, name).toBe(true);
    }
    expect(byName('render in an uncalled local function')).toMatchObject({ symbols: [], asserted: false });
  });

  it('counts calls in an inline handler of a DOM element only when the test fires events', () => {
    const byName = inventory(`${header}
      it('handler never fired', () => {
        let clicked = false;
        const { getByText } = render(<button onClick={() => { clicked = label('a') !== ''; }}>Go</button>);
        expect(getByText('Go')).toBeTruthy();
        expect(clicked).toBe(false);
      });
      it('handler fired', () => {
        let clicked = false;
        const { getByText } = render(<button onClick={() => { clicked = label('a') !== ''; }}>Go</button>);
        fireEvent.click(getByText('Go'));
        expect(clicked).toBe(true);
      });
    `);

    expect(byName('handler never fired')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('handler fired').symbols).toEqual(['src/format.ts#label']);
  });
});

describe('helper mount positions, render results, explicit children and mock reads', () => {
  it('places a render in a local helper where the helper is called', () => {
    const byName = inventory(`${header}
      it('read before the helper call', () => {
        function mount() { render(<Dialog open title="Hi" />); }
        const before = screen.queryByText('Hi');
        mount();
        expect(before).toBeNull();
      });
      it('read after the helper call', () => {
        function mount() { render(<Dialog open title="Hi" />); }
        mount();
        const after = screen.queryByText('Hi');
        expect(after).not.toBeNull();
      });
    `);

    expect(byName('read before the helper call').asserted).toBe(false);
    expect(byName('read after the helper call').asserted).toBe(true);
  });

  it('counts only output of a render result', () => {
    const byName = inventory(`${header}
      it('unmount compared', () => {
        const { unmount } = render(<Dialog open title="Hi" />);
        expect(unmount).toBeTypeOf('function');
      });
      it('query not called', () => {
        const { getByText } = render(<Dialog open title="Hi" />);
        expect(getByText).toBeDefined();
      });
      it('query through the result not called', () => {
        const view = render(<Dialog open title="Hi" />);
        expect(view.getByText).toBeDefined();
      });
      it('container read', () => {
        const { container } = render(<Dialog open title="Hi" />);
        expect(container.textContent).toContain('Hi');
      });
      it('query through the result called', () => {
        const view = render(<Dialog open title="Hi" />);
        expect(view.getByText('Hi')).toBeTruthy();
      });
    `);

    for (const name of ['unmount compared', 'query not called', 'query through the result not called'])
      expect(byName(name).asserted, name).toBe(false);
    expect(byName('container read').asserted).toBe(true);
    expect(byName('query through the result called').asserted).toBe(true);
  });

  it('treats an explicit children prop like child nodes in the pass-through check', () => {
    const byName = inventory(
      `${header}
      import { Section } from '../src/Section';
      it('children prop with a DOM element', () => {
        render(<Section children={<button>Hi</button>} />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('children prop with the component', () => {
        render(<Section children={<Dialog open title="Hi" />} />);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
    `,
      {
        'src/Section.tsx':
          'export const Section = ({ children }: { children?: unknown }) => <section>{children}</section>;\n',
      },
    );

    expect(byName('children prop with a DOM element')).toMatchObject({
      symbols: ['src/Section.tsx#Section'],
      asserted: false,
    });
    expect(byName('children prop with the component').asserted).toBe(true);
  });

  it('does not count a mock that is only read in a prop as handed over', () => {
    const byName = inventory(`${header}
      it('mock state read in a prop', () => {
        const onSave = vi.fn();
        render(<Dialog title={String(onSave.mock.calls.length)} />);
        expect(onSave).not.toHaveBeenCalled();
      });
      it('mock handed over', () => {
        const onSave = vi.fn();
        render(<Dialog onSave={onSave} />);
        expect(onSave).not.toHaveBeenCalled();
      });
    `);

    expect(byName('mock state read in a prop').asserted).toBe(false);
    expect(byName('mock handed over').asserted).toBe(true);
  });
});

describe('helper calls that run and pass-through render results', () => {
  it('follows a query helper only when the call to it runs', () => {
    const byName = inventory(
      `${header}
      function query() { return screen.queryByText('Hi'); }
      it('helper call in a compared function', () => {
        render(<Dialog open title="Hi" />);
        expect(() => query()).toBeTruthy();
      });
      it('helper call in a function run by waitFor', async () => {
        render(<Dialog open title="Hi" />);
        expect(await waitFor(() => query())).toBeTruthy();
      });
    `.replace(
        "from '@testing-library/react';",
        "from '@testing-library/react';\nimport { waitFor } from '@testing-library/react';",
      ),
    );

    expect(byName('helper call in a compared function').asserted).toBe(false);
    expect(byName('helper call in a function run by waitFor').asserted).toBe(true);
  });

  it('does not credit a pass-through wrapper through render-result queries', () => {
    const byName = inventory(
      `${header}
      import { Section } from '../src/Section';
      it('render-result query on a pass-through wrapper', () => {
        const { getByText } = render(<Section><button>Hi</button></Section>);
        expect(getByText('Hi')).toBeTruthy();
      });
      it('render-result query with the component inside', () => {
        const { getByText } = render(<Section><Dialog open title="Hi" /></Section>);
        expect(getByText('Hi')).toBeTruthy();
      });
    `,
      {
        'src/Section.tsx':
          'export const Section = ({ children }: { children?: unknown }) => <section>{children}</section>;\n',
      },
    );

    expect(byName('render-result query on a pass-through wrapper')).toMatchObject({
      symbols: ['src/Section.tsx#Section'],
      asserted: false,
    });
    expect(byName('render-result query with the component inside').asserted).toBe(true);
  });
});

describe('evaluated names, helper write positions and per-call factories', () => {
  it('follows a local only when the assertion evaluates it', () => {
    const byName = inventory(`${header}
      it('local in a compared function', () => {
        render(<Dialog open title="Hi" />);
        const value = screen.queryByText('Hi');
        expect(() => value).toBeTruthy();
      });
      it('local compared', () => {
        render(<Dialog open title="Hi" />);
        const value = screen.queryByText('Hi');
        expect(value).toBeTruthy();
      });
    `);

    expect(byName('local in a compared function').asserted).toBe(false);
    expect(byName('local compared').asserted).toBe(true);
  });

  it('places a write in a local helper where the helper is called', () => {
    const byName = inventory(`${header}
      it('helper write after the read', () => {
        function reset() { document.body.innerHTML = ''; }
        render(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeTruthy();
        reset();
      });
      it('helper write before the read', () => {
        function fill() { document.body.innerHTML = '<p>Hi</p>'; }
        render(<Dialog open />);
        fill();
        expect(screen.getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('helper write after the read').asserted).toBe(true);
    expect(byName('helper write before the read').asserted).toBe(false);
  });

  it('decides per call whether what a factory returns is mounted', () => {
    const byName = inventory(`${header}
      function make() { return <Dialog open title="Hi" />; }
      it('factory result rendered', () => {
        render(make());
        expect(screen.getByText('Hi')).toBeTruthy();
      });
      it('factory called, result not rendered', () => {
        make();
        expect(screen.queryByText('Hi')).toBeNull();
      });
    `);

    expect(byName('factory result rendered')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
    expect(byName('factory called, result not rendered')).toMatchObject({ symbols: [], asserted: false });
  });
});

describe('nested runs, API aliases, named hooks and helper writes', () => {
  it('requires every function up to the compared value to run', () => {
    const byName = inventory(`${header}
      it('callback in a compared function', () => {
        render(<Dialog open title="Hi" />);
        expect(() => [1].map(() => screen.getByText('Hi'))).toBeTruthy();
      });
      it('callback in a compared value', () => {
        render(<Dialog open title="Hi" />);
        expect([1].map(() => screen.getByText('Hi'))).toHaveLength(1);
      });
    `);

    expect(byName('callback in a compared function').asserted).toBe(false);
    expect(byName('callback in a compared value').asserted).toBe(true);
  });

  it('keeps an alias of a render-result API member as API', () => {
    const byName = inventory(`${header}
      it('alias of unmount', () => {
        const { unmount } = render(<Dialog open title="Hi" />);
        const saved = unmount;
        expect(saved).toBeTypeOf('function');
      });
      it('alias of a query, called', () => {
        const { getByText } = render(<Dialog open title="Hi" />);
        const find = getByText;
        expect(find('Hi')).toBeTruthy();
      });
    `);

    expect(byName('alias of unmount').asserted).toBe(false);
    expect(byName('alias of a query, called').asserted).toBe(true);
  });

  it('follows renders and writes of a named function registered with a hook', () => {
    const byName = inventory(`${header}
      function mount() { render(<Dialog open title="Hi" />); }
      function fill() { document.body.innerHTML = '<p>fixture</p>'; }
      describe('named mount', () => {
        beforeEach(mount);
        it('shown', () => { expect(screen.getByText('Hi')).toBeInTheDocument(); });
      });
      describe('named mount and fixture write', () => {
        beforeEach(fill);
        beforeEach(mount);
        it('fixture read', () => { expect(screen.getByText('fixture')).toBeInTheDocument(); });
      });
      describe('elsewhere', () => {
        it('not mounted here', () => { expect(screen.queryByText('Hi')).toBeNull(); });
      });
    `);

    expect(byName('shown')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
    expect(byName('fixture read')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: false });
    expect(byName('not mounted here')).toMatchObject({ symbols: [], asserted: false });
  });

  it('places writes of a module-level helper where the test calls it', () => {
    const byName = inventory(`${header}
      function writePage() { document.body.innerHTML = '<p>Hi</p>'; }
      it('helper write before the render', () => {
        writePage();
        render(<Dialog open />);
        expect(screen.getByText('Hi')).toBeTruthy();
      });
      it('helper write after the read', () => {
        render(<Dialog open title="Hi" />);
        expect(screen.getByText('Hi')).toBeTruthy();
        writePage();
      });
    `);

    expect(byName('helper write before the render').asserted).toBe(false);
    expect(byName('helper write after the read').asserted).toBe(true);
  });
});

describe('observation timing, caller chains, inline members, containers, shallow and fixture queries', () => {
  it('requires a mock to be observed after it was handed over', () => {
    const byName = inventory(`${header}
      it('mock state read before the render', () => {
        const cb = vi.fn();
        const before = cb.mock.calls.length;
        render(<Dialog onSave={cb} />);
        expect(before).toBe(0);
      });
      it('mock matcher before the render', () => {
        const cb = vi.fn();
        expect(cb).not.toHaveBeenCalled();
        render(<Dialog onSave={cb} />);
      });
      it('mock matcher after the render', () => {
        const cb = vi.fn();
        render(<Dialog onSave={cb} />);
        expect(cb).not.toHaveBeenCalled();
      });
    `);

    expect(byName('mock state read before the render').asserted).toBe(false);
    expect(byName('mock matcher before the render').asserted).toBe(false);
    expect(byName('mock matcher after the render').asserted).toBe(true);
  });

  it('requires the callers of a mounting helper to run, transitively', () => {
    const byName = inventory(`${header}
      it('only an uncalled caller', () => {
        function unused() { mount(); }
        function mount() { render(<Dialog open title="Hi" />); }
        expect(document.body.textContent).toBe('');
      });
      it('caller called', () => {
        function used() { mount(); }
        function mount() { render(<Dialog open title="Hi" />); }
        used();
        expect(document.body.textContent).toContain('Hi');
      });
    `);

    expect(byName('only an uncalled caller')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('caller called')).toMatchObject({ symbols: ['src/Dialog.tsx#Dialog'], asserted: true });
  });

  it('classifies members read straight off an inline render', () => {
    const byName = inventory(`${header}
      it('inline unmount', () => { expect(render(<Dialog open title="Hi" />).unmount).toBeTypeOf('function'); });
      it('inline query not called', () => { expect(render(<Dialog open title="Hi" />).getByText).toBeDefined(); });
      it('inline container', () => { expect(render(<Dialog open title="Hi" />).container.textContent).toContain('Hi'); });
      it('inline query called', () => { expect(render(<Dialog open title="Hi" />).getByText('Hi')).toBeTruthy(); });
    `);

    expect(byName('inline unmount').asserted).toBe(false);
    expect(byName('inline query not called').asserted).toBe(false);
    expect(byName('inline container').asserted).toBe(true);
    expect(byName('inline query called').asserted).toBe(true);
  });

  it('keeps a render into a detached container out of the page', () => {
    const byName = inventory(`${header}
      it('detached container, screen query', () => {
        render(<Dialog open title="Hi" />, { container: document.createElement('div') });
        expect(screen.queryByText('Hi')).toBeNull();
      });
      it('detached container, render result', () => {
        const { container } = render(<Dialog open title="Hi" />, { container: document.createElement('div') });
        expect(container.textContent).toContain('Hi');
      });
      it('appended container, screen query', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        render(<Dialog open title="Hi" />, { container: host });
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      });
    `);

    expect(byName('detached container, screen query')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: false,
    });
    expect(byName('detached container, render result').asserted).toBe(true);
    expect(byName('appended container, screen query').symbols).toEqual(['src/Dialog.tsx#Dialog']);
  });

  it('runs only the root component of an Enzyme shallow render', () => {
    const byName = inventory(`${header}
      import { shallow } from 'enzyme';
      it('component nested in shallow', () => {
        const tree = shallow(<div><Dialog open title="Hi" /></div>);
        expect(tree.exists()).toBe(true);
      });
      it('component at the shallow root', () => {
        const tree = shallow(<Dialog open title="Hi" />);
        expect(tree.exists()).toBe(true);
      });
    `);

    expect(byName('component nested in shallow')).toMatchObject({ symbols: [], asserted: false });
    expect(byName('component at the shallow root')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
  });

  it('does not credit a render-result query that may find content the test wrote', () => {
    const byName = inventory(`${header}
      it('query after a fixture write', () => {
        const { getByText } = render(<Dialog open title="Hi" />);
        document.body.innerHTML = '<p>fixture</p>';
        expect(getByText('fixture')).toBeTruthy();
      });
      it('query without writes', () => {
        const { getByText } = render(<Dialog open title="Hi" />);
        expect(getByText('Hi')).toBeTruthy();
      });
    `);

    expect(byName('query after a fixture write').asserted).toBe(false);
    expect(byName('query without writes').asserted).toBe(true);
  });
});

describe('assert callbacks, live references, screen aliases, Enzyme output and portals', () => {
  it('runs callbacks given to assert.throws and chai throw matchers', () => {
    const root = tempProject({
      'src/plain.ts':
        "export function fail(): never { throw new Error('bad'); }\nexport const ok = () => 1;\n",
      'test/plain.test.ts': `import { assert, expect, it } from 'vitest';
import { fail, ok } from '../src/plain';
it('assert throws', () => { assert.throws(() => fail(), /bad/); });
it('assert does not throw', () => { assert.doesNotThrow(() => ok()); });
it('chai throw', () => { expect(() => fail()).to.throw(/bad/); });
it('compared only', () => { assert.ok(() => fail()); });
`,
    });
    const tests = inventoryTests({ root, config: VeritasConfig.parse({}) }).tests;
    const asserted = (name: string) =>
      tests.find((test) => test.name === name)?.targetCalls.some((call) => call.asserted);

    for (const name of ['assert throws', 'assert does not throw', 'chai throw'])
      expect(asserted(name), name).toBe(true);
    expect(asserted('compared only')).toBe(false);
  });

  it('reads a live element held in a local where it is used', () => {
    const byName = inventory(`${header}
      it('live body read after the render', () => {
        const body = document.body;
        render(<Dialog open title="Hi" />);
        expect(body.textContent).toBe('Hi');
      });
      it('text captured before the render', () => {
        const text = document.body.textContent;
        render(<Dialog open title="Hi" />);
        expect(text).toBe('');
      });
      it('query captured before the render', () => {
        const before = screen.queryByText('Hi');
        render(<Dialog open title="Hi" />);
        expect(before).toBeNull();
      });
    `);

    expect(byName('live body read after the render').asserted).toBe(true);
    expect(byName('text captured before the render').asserted).toBe(false);
    expect(byName('query captured before the render').asserted).toBe(false);
  });

  it('resolves screen queries taken off screen into locals', () => {
    const byName = inventory(`${header}
      it('destructured from screen', () => {
        render(<Dialog open title="Hi" />);
        const { getByText } = screen;
        expect(getByText('Hi')).toBeTruthy();
      });
      it('alias of a screen query', () => {
        render(<Dialog open title="Hi" />);
        const find = screen.getByText;
        expect(find('Hi')).toBeTruthy();
      });
      it('destructured, nothing rendered', () => {
        label('a');
        const { getByText } = screen;
        expect(getByText('A')).toBeTruthy();
      });
    `);

    expect(byName('destructured from screen').asserted).toBe(true);
    expect(byName('alias of a screen query').asserted).toBe(true);
    expect(byName('destructured, nothing rendered').asserted).toBe(false);
  });

  it('keeps Enzyme output methods as output', () => {
    const byName = inventory(`${header}
      import { shallow } from 'enzyme';
      it('inline enzyme debug', () => { expect(shallow(<Dialog open title="Hi" />).debug()).toContain('Hi'); });
      it('stored enzyme text', () => {
        const tree = shallow(<Dialog open title="Hi" />);
        expect(tree.text()).toContain('Hi');
      });
      it('testing library debug compared', () => {
        const { debug } = render(<Dialog open title="Hi" />);
        expect(debug).toBeTypeOf('function');
      });
    `);

    expect(byName('inline enzyme debug').asserted).toBe(true);
    expect(byName('stored enzyme text').asserted).toBe(true);
    expect(byName('testing library debug compared').asserted).toBe(false);
  });

  it('follows the child of a mounted portal into its destination', () => {
    const byName = inventory(`${header}
      import { createPortal } from 'react-dom';
      it('portal into the body', () => {
        render(<>{createPortal(<Dialog open title="Hi" />, document.body)}</>);
        expect(screen.getByText('Hi')).toBeInTheDocument();
      });
      it('portal into a detached node', () => {
        render(<>{createPortal(<Dialog open title="Hi" />, document.createElement('div'))}</>);
        expect(screen.queryByText('Hi')).toBeNull();
      });
      it('portal never mounted', () => {
        const portal = createPortal(<Dialog open title="Hi" />, document.body);
        expect(portal).toBeTruthy();
      });
    `);

    expect(byName('portal into the body')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: true,
    });
    expect(byName('portal into a detached node')).toMatchObject({
      symbols: ['src/Dialog.tsx#Dialog'],
      asserted: false,
    });
    expect(byName('portal never mounted')).toMatchObject({ symbols: [], asserted: false });
  });
});

describe('large component test files', () => {
  const file = (count: number) => {
    let source = `${header}
      const shared = { onSave: vi.fn(), onClose: vi.fn() };
      let onSave: ReturnType<typeof vi.fn>;
      beforeEach(() => { onSave = vi.fn(); });
    `;

    for (let index = 0; index < count; index++)
      source += `
      it('t${index}', () => {
        const props = { onSave: vi.fn(), title: 'x${index}' };
        render(<Dialog {...props} onClose={shared.onClose} onSave={asMock<() => void>(onSave)} />);
        expect(screen.getByText('x${index}')).toBeTruthy();
        expect(props.onSave).toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
      });
    `;

    return source;
  };
  const timed = (count: number) => {
    const started = Date.now();
    const byName = inventory(file(count));

    expect(byName(`t${count - 1}`).asserted).toBe(true);

    return Date.now() - started;
  };

  it('grows about linearly with the number of tests sharing a mock of the file', () => {
    timed(20);
    const small = timed(100);
    const large = timed(400);

    // Four times the tests: linear work takes about four times as long (less, with the fixed cost of the program);
    // work per test that grows with the file takes about sixteen times as long.
    expect(large).toBeLessThan(8 * small + 1000);
  }, 120_000);
});
