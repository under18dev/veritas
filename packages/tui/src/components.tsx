import path from 'node:path';
import { VeritasError } from '@under18dev/veritas-core';
import { Box, type DOMElement, Text, useBoxMetrics, useInput } from 'ink';
import { type ReactNode, useEffect, useRef, useState } from 'react';

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
  render,
}: {
  items: Item<T>[];
  active: boolean;
  height?: number;
  onSelect?: (item: Item<T>, index: number) => void;
  onHighlight?: (item: Item<T>, index: number) => void;
  initial?: number;
  /** Move the highlight here when it changes, for a selection made elsewhere (a shortcut key). */
  selected?: number;
  /** Draw a row yourself instead of the label and hint; the row is one line. */
  render?: (item: Item<T>, selected: boolean) => ReactNode;
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

        if (render)
          return (
            <Box key={`row-${row}`} height={1} overflow="hidden">
              <Box flexShrink={0} width={2}>
                <Text color="cyan">{selected ? '›' : ' '}</Text>
              </Box>
              {render(item, selected)}
            </Box>
          );

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
  errors = [],
  hint = 'Enter to confirm, Esc to cancel',
}: {
  label: string;
  initial?: string;
  active: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Why the last value was refused, shown under the field. */
  errors?: string[];
  hint?: string;
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
      {errors.map((e) => (
        <Text key={e} color="red" wrap="wrap">
          {e}
        </Text>
      ))}
      <Text dimColor>{hint}</Text>
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

/** A rounded box with a bold title line, the building block of the dashboard and the detail views. */
export function Card({
  title,
  right,
  children,
  color = 'gray',
  ...box
}: {
  title: string;
  /** Shown after the title, such as a badge. */
  right?: ReactNode;
  children?: ReactNode;
  color?: string;
  width?: number | string;
  flexGrow?: number;
  flexBasis?: number | string;
  marginRight?: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} flexShrink={0} {...box}>
      <Box>
        <Box flexShrink={0}>
          <Text bold>{title}</Text>
        </Box>
        {right ? (
          <Box marginLeft={1} flexShrink={1} overflow="hidden" height={1}>
            {right}
          </Box>
        ) : null}
      </Box>
      {children}
    </Box>
  );
}

/**
 * Content taller than `height` scrolled with ↑/↓ or j/k, PgUp/PgDn and Space. The last row says which rows are
 * shown when the content does not fit.
 */
export function ScrollView({
  active,
  height,
  children,
}: {
  active: boolean;
  height: number;
  children: ReactNode;
}) {
  const ref = useRef<DOMElement>(null);
  const content = useBoxMetrics(ref).height;
  const [top, setTop] = useState(0);
  const overflow = content > height;
  const rows = overflow ? Math.max(1, height - 1) : height;
  const max = Math.max(0, content - rows);
  const offset = Math.min(top, max);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setTop(Math.max(0, offset - 1));
      else if (key.downArrow || input === 'j') setTop(Math.min(max, offset + 1));
      else if (key.pageUp) setTop(Math.max(0, offset - rows));
      else if (key.pageDown || input === ' ') setTop(Math.min(max, offset + rows));
    },
    { isActive: active && overflow },
  );

  return (
    <Box flexDirection="column">
      <Box height={rows} overflow="hidden" contentOffsetY={offset} flexDirection="column">
        <Box ref={ref} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      {overflow ? (
        <Text dimColor>
          rows {offset + 1}-{Math.min(content, offset + rows)} of {content}, ↑↓ to scroll
        </Text>
      ) : null}
    </Box>
  );
}

/** Mark and color of a recorded stage status: only `succeeded` is green. */
export const STAGE_MARK: Record<string, { mark: string; color: string }> = {
  succeeded: { mark: '✔', color: 'green' },
  partial: { mark: '!', color: 'yellow' },
  skipped: { mark: '-', color: 'gray' },
  unsupported: { mark: '!', color: 'yellow' },
  cancelled: { mark: '✖', color: 'yellow' },
  timeout: { mark: '✖', color: 'yellow' },
  error: { mark: '✖', color: 'red' },
  failed: { mark: '✖', color: 'red' },
};

export function stageMark(status: string): { mark: string; color: string } {
  return STAGE_MARK[status] ?? { mark: '?', color: 'yellow' };
}

/** Recorded stages side by side, each with its mark and, with `timings`, how long it took; they wrap to fit. */
export function StageStrip({
  stages,
  timings = false,
}: {
  stages: { stage: string; status: string; durationMs?: number }[];
  timings?: boolean;
}) {
  return (
    <Box flexWrap="wrap">
      {stages.map((s) => {
        const { mark, color } = stageMark(s.status);

        return (
          <Box key={s.stage} marginRight={2} flexShrink={0}>
            <Text>
              <Text color={color}>{mark}</Text> {s.stage}
              {s.status !== 'succeeded' ? <Text color={color}> {s.status}</Text> : null}
              {timings && s.durationMs !== undefined ? <Text dimColor> {duration(s.durationMs)}</Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

const STATUS_COLOR: Record<string, string> = {
  // test outcomes
  meaningful_with_evidence: 'green',
  tautological_or_disconnected: 'red',
  spec_conflict: 'red',
  // mutants
  killed: 'green',
  survived: 'red',
  // property-based tests
  passed: 'green',
  counterexample: 'red',
  // solver claims
  proven_within_model: 'green',
  counterexample_found: 'red',
  semantic_mismatch: 'red',
  failed: 'red',
  error: 'red',
};

/**
 * The color of an evidence status (test outcome, mutant, property-based test or solver claim): green only for a
 * result known to be good, red for a failure or counterexample, yellow for anything else (weak, unknown, timeout,
 * cancelled, unsupported).
 */
export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? 'yellow';
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'red',
  high: 'red',
  medium: 'yellow',
  low: 'blue',
  info: 'gray',
};

/** Most severe first. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export function severityColor(severity: string): string {
  return SEVERITY_COLOR[severity] ?? 'gray';
}

/** The severity in capitals and its color, padded so that titles after it line up. */
export function SeverityLabel({ severity }: { severity: string }) {
  return (
    <Text color={severityColor(severity)} bold>
      {severity.toUpperCase().padEnd(9)}
    </Text>
  );
}

/** `850 ms`, `12.3 s` or `4m 05s`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);

  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** How long ago `iso` was: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);

  if (!Number.isFinite(ms)) return '?';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;

  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** How long a run took, or null while it has no end time. */
export function runDuration(run: { startedAt: string; finishedAt?: string | undefined }): number | null {
  if (!run.finishedAt) return null;
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);

  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Count values by key, in first-seen order. */
export function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();

  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);

  return [...counts];
}

/** The keys that work in a view, each as a highlighted key and what it does. */
export type Hints = [string, string][];

/** `file` relative to `root`, written with `/` on every platform, as paths are shown elsewhere in Veritas. */
export function projectPath(root: string, file: string): string {
  return (path.relative(root, file) || file).split(path.sep).join('/');
}
