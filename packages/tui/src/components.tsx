import { VeritasError } from '@under18dev/veritas-core';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

/** Text lines keyed by their line number, which is what identifies a row of a fixed text. */
export function numbered(lines: string[], from = 0): { key: string; n: number; text: string }[] {
  return lines.map((text, n) => ({ key: `line-${from + n}`, n: from + n, text }));
}

export interface Item<T> {
  label: string;
  value: T;
  hint?: string;
}

/** A vertical list moved with ↑/↓ or j/k and chosen with Enter. Only the rows that fit in `height` are drawn. */
export function SelectList<T>({
  items,
  active,
  height = 15,
  onSelect,
  onHighlight,
  initial = 0,
  selected,
}: {
  items: Item<T>[];
  active: boolean;
  height?: number;
  onSelect?: (item: Item<T>, index: number) => void;
  onHighlight?: (item: Item<T>, index: number) => void;
  initial?: number;
  /** Move the highlight here when it changes, for a selection made elsewhere (a shortcut key). */
  selected?: number;
}) {
  const [index, setIndex] = useState(Math.min(selected ?? initial, Math.max(items.length - 1, 0)));
  const current = Math.min(index, Math.max(items.length - 1, 0));

  useEffect(() => {
    if (selected !== undefined && selected >= 0) setIndex(selected);
  }, [selected]);

  useEffect(() => {
    const item = items[current];
    if (item) onHighlight?.(item, current);
  }, [current, items, onHighlight]);

  useInput(
    (input, key) => {
      if (items.length === 0) return;
      if (key.upArrow || input === 'k') setIndex((i) => Math.max(0, Math.min(i, items.length - 1) - 1));
      else if (key.downArrow || input === 'j') setIndex((i) => Math.min(items.length - 1, i + 1));
      else if (key.return) {
        const item = items[current];
        if (item) onSelect?.(item, current);
      }
    },
    { isActive: active },
  );

  if (items.length === 0) return <Text dimColor>(nothing to show)</Text>;
  const start = Math.max(0, Math.min(current - Math.floor(height / 2), items.length - height));
  const visible = items.slice(start, start + height);

  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const row = start + i;
        const selected = row === current;

        return (
          <Text key={`row-${row}`} wrap="truncate-end" {...(selected ? { color: 'cyan' } : {})}>
            {selected ? '› ' : '  '}
            {item.label}
            {item.hint ? <Text dimColor> {item.hint}</Text> : null}
          </Text>
        );
      })}
      {items.length > height ? (
        <Text dimColor>
          {current + 1}/{items.length}
        </Text>
      ) : null}
    </Box>
  );
}

/** Long text scrolled with ↑/↓ or j/k. */
export function Pager({ lines, active, height = 15 }: { lines: string[]; active: boolean; height?: number }) {
  const [top, setTop] = useState(0);
  const max = Math.max(0, lines.length - height);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setTop((t) => Math.max(0, t - 1));
      else if (key.downArrow || input === 'j') setTop((t) => Math.min(max, t + 1));
      else if (key.pageUp) setTop((t) => Math.max(0, t - height));
      else if (key.pageDown || input === ' ') setTop((t) => Math.min(max, t + height));
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column">
      {numbered(lines.slice(top, top + height), top).map((line) => (
        <Text key={line.key} wrap="truncate-end">
          {line.text === '' ? ' ' : line.text}
        </Text>
      ))}
      {lines.length > height ? (
        <Text dimColor>
          lines {top + 1}-{Math.min(lines.length, top + height)} of {lines.length}
        </Text>
      ) : null}
    </Box>
  );
}

/** A one-line text field. Enter submits, Esc cancels. */
export function TextInput({
  label,
  initial = '',
  active,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  active: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  useInput(
    (input, key) => {
      if (key.escape) onCancel();
      else if (key.return) onSubmit(value);
      else if (key.backspace || key.delete) setValue((v) => v.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow)
        setValue((v) => v + input);
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Text>
        <Text color="cyan">› </Text>
        {value}
        <Text inverse> </Text>
      </Text>
      <Text dimColor>Enter to confirm, Esc to cancel</Text>
    </Box>
  );
}

/** Asks a yes/no question: y confirms, n or Esc declines. */
export function Confirm({
  question,
  active,
  onYes,
  onNo,
}: {
  question: string;
  active: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') onYes();
      else if (input === 'n' || input === 'N' || key.escape) onNo();
    },
    { isActive: active },
  );

  return (
    <Text>
      {question} <Text color="cyan">[y/N]</Text>
    </Text>
  );
}

export function errorText(error: unknown): string[] {
  if (error instanceof VeritasError)
    return [`${error.code}: ${error.message}`, ...(error.hint ? [`hint: ${error.hint}`] : [])];

  return [error instanceof Error ? error.message : String(error)];
}

export function ErrorView({ error }: { error: unknown }) {
  return (
    <Box flexDirection="column">
      {numbered(errorText(error)).map((line) => (
        <Text key={line.key} {...(line.n === 0 ? { color: 'red' } : {})} wrap="wrap">
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

export function Title({ children }: { children: string }) {
  return (
    <Box marginBottom={1}>
      <Text bold>{children}</Text>
    </Box>
  );
}

/** Runs `load` once and keeps its result or error. */
export function useLoad<T>(load: () => T | Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: callers list what the load depends on
  useEffect(() => {
    let live = true;

    setState({ loading: true });
    Promise.resolve()
      .then(load)
      .then(
        (data) => live && setState({ data, loading: false }),
        (error: unknown) => live && setState({ error, loading: false }),
      );

    return () => {
      live = false;
    };
  }, [nonce, ...deps]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** Spinner frames (braille, one column wide in every terminal). */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The color a run verdict is shown in. */
export function verdictColor(verdict: string | undefined): string {
  if (verdict === 'pass') return 'green';
  if (verdict === 'policy_failure' || verdict === 'tool_error') return 'red';

  return verdict ? 'yellow' : 'gray';
}

/** A short label on a colored background. */
export function Badge({ color, children }: { color: string; children: string }) {
  return (
    <Text backgroundColor={color} color="black" bold>
      {` ${children} `}
    </Text>
  );
}

/** A bar of colored blocks; spaces with a background, so it lines up in terminals that draw block characters wide. */
export function ProgressBar({ done, total, width }: { done: number; total: number; width: number }) {
  const filled = total > 0 ? Math.min(width, Math.round((done / total) * width)) : 0;

  return (
    <Text>
      <Text backgroundColor="cyan">{' '.repeat(filled)}</Text>
      <Text backgroundColor="gray">{' '.repeat(width - filled)}</Text>
    </Text>
  );
}
