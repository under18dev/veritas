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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      it('query selector after inner HTML', () => {
        document.documentElement.innerHTML = '<p class="x">Hi</p>';
        render(<Dialog open />);
        expect(document.querySelector('.x')).not.toBeNull();
      });
    `);

    expect(byName('screen after appended content').asserted).toBe(false);
    expect(byName('query selector after inner HTML').asserted).toBe(false);
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
