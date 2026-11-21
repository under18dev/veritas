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
