import path from 'node:path';
import {
  type ConfigField,
  type ConfigSection,
  configSections,
  VeritasConfig,
} from '@under18dev/veritas-core';
import { Box, type DOMElement, Text, useBoxMetrics, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Card,
  Confirm,
  ErrorView,
  errorText,
  type Hints,
  numbered,
  ScrollView,
  TextInput,
  useLoad,
} from '../components.js';
import type { ScreenProps } from '../screen.js';

type Path = (string | number)[];

/** Every setting of the configuration schema, grouped by section, with its description and default. */
export const SECTIONS: ConfigSection[] = configSections();
const FIELDS = SECTIONS.flatMap((s) => s.fields);

export function getAt(root: unknown, path: Path): unknown {
  let value = root;

  for (const key of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key as string];
  }

  return value;
}

export function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...Path];
  const base =
    root !== null && typeof root === 'object' && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : {};

  return { ...base, [head]: setAt(base[head], rest, value) };
}

/** Remove a value, and the objects that it leaves empty, so the default applies again. */
export function unsetAt(root: unknown, path: Path): unknown {
  if (root === null || typeof root !== 'object' || Array.isArray(root) || path.length === 0) return root;
  const [head, ...rest] = path as [string, ...Path];
  const { [head]: child, ...others } = root as Record<string, unknown>;

  if (child === undefined) return root;
  if (rest.length === 0) return others;
  const next = unsetAt(child, rest);
  const empty =
    next !== null && typeof next === 'object' && !Array.isArray(next) && Object.keys(next).length === 0;

  return empty ? others : { ...others, [head]: next };
}

/** Check a candidate configuration with the schema the CLI uses; returns `path: message` lines. */
export function validate(raw: unknown): string[] {
  const result = VeritasConfig.safeParse(raw);

  return result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const key = (field: ConfigField) => field.path.join('.');

/** The value in effect: the one written in the file, or the default. */
export function effective(raw: unknown, field: ConfigField): unknown {
  const value = getAt(raw, field.path);

  return value === undefined ? field.default : value;
}

/** Whether the value in effect differs from the default. */
export function changed(raw: unknown, field: ConfigField): boolean {
  return !same(effective(raw, field), field.default);
}

/**
 * Write a value. A field that must be present once its object exists (such as `formal.integerDomain.min`) gets its
 * required siblings filled with their defaults, so changing one of them does not leave the object incomplete.
 */
export function setField(raw: unknown, field: ConfigField, value: unknown): unknown {
  const parent = field.path.slice(0, -1);
  let next = raw;

  if (field.required && getAt(raw, parent) === undefined)
    for (const sibling of FIELDS)
      if (sibling.required && same(sibling.path.slice(0, -1), parent))
        next = setAt(next, sibling.path, sibling.default);

  return setAt(next, field.path, value);
}

/** Reset to the default: remove the value, or write the default where the value must be present. */
export function resetField(raw: unknown, field: ConfigField): unknown {
  return field.required ? setAt(raw, field.path, field.default) : unsetAt(raw, field.path);
}

/**
 * Keep the file as close as possible to what was saved: a value set back to its default that the saved file did not
 * have is removed, and so is an object (such as `formal.integerDomain`) that holds only defaults the saved file did
 * not have.
 */
export function tidy(saved: unknown, edited: unknown, field: ConfigField): unknown {
  let next = edited;

  if (
    !field.required &&
    getAt(saved, field.path) === undefined &&
    same(getAt(next, field.path), field.default)
  )
    next = unsetAt(next, field.path);
  const parent = field.path.slice(0, -1);
  const object = getAt(next, parent);

  if (
    parent.length > 1 &&
    getAt(saved, parent) === undefined &&
    object !== null &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    Object.entries(object).every(([name, value]) => {
      const sibling = FIELDS.find((f) => same(f.path, [...parent, name]));

      return sibling !== undefined && same(value, sibling.default);
    })
  )
    next = unsetAt(next, parent);

  return next;
}

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
  field: ConfigField;
}

/** The settings whose written value differs between the saved file and the edited one. */
export function diff(saved: unknown, draft: unknown): Change[] {
  return FIELDS.filter((f) => !same(getAt(saved, f.path), getAt(draft, f.path))).map((f) => ({
    path: key(f),
    before: getAt(saved, f.path),
    after: getAt(draft, f.path),
    field: f,
  }));
}

const UNSET = Symbol('unset');

/** Read typed text as a value of the field's type, or say why it is not one. */
export function parseText(text: string, field: ConfigField): { value: unknown } | { error: string } {
  const t = text.trim();

  if (t === '' && field.nullable) return { value: null };
  if (t === '' && field.default === undefined) return { value: UNSET };
  if (field.type === 'integer')
    return /^-?\d+$/.test(t) ? { value: Number(t) } : { error: 'Enter a whole number, such as 5000.' };
  if (field.type === 'number')
    return t !== '' && Number.isFinite(Number(t))
      ? { value: Number(t) }
      : { error: 'Enter a number, such as 0.5.' };

  return { value: t };
}

const WORDS: Record<string, string> = {
  github: 'GitHub',
  llm: 'LLM',
  pbt: 'PBT',
  ms: '(ms)',
  mb: '(MiB)',
  smt: 'SMT',
  tsconfig: 'tsconfig',
  $schema: '$schema',
};

/** A readable name for a key, such as `maxDurationMs` -> `Max duration (ms)`. */
export function humanize(name: string): string {
  if (WORDS[name]) return WORDS[name];
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const text = words.join(' ');

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The label of a field inside its section: nested keys become a prefix, such as `Web: max pages`. */
export function fieldLabel(field: ConfigField): string {
  const inner = field.path.length > 1 ? field.path.slice(1) : field.path;
  const last = humanize(inner.at(-1) ?? '');

  if (inner.length === 1) return last;

  return `${inner.slice(0, -1).map(humanize).join(' ')}: ${last.charAt(0).toLowerCase()}${last.slice(1)}`;
}

const SECTION_TITLE: Record<string, string> = {
  '': 'General',
  pbt: 'Property-based testing',
  formal: 'Formal verification',
  mutation: 'Mutation testing',
  improvement: 'Test improvement',
};

export function sectionTitle(section: ConfigSection): string {
  return SECTION_TITLE[section.key] ?? humanize(section.key);
}

/**
 * Settings that let Veritas use the network or an LLM, which are off by default, and what turning them on does.
 * `on` says whether a value turns the effect on.
 */
export const EFFECTS: Record<
  string,
  { tag: 'network' | 'LLM'; on: (value: unknown) => boolean; note: string }
> = {
  'sources.github.enabled': {
    tag: 'network',
    on: (v) => v === true,
    note: 'Reads issues and pull requests from GitHub over the network in runs that are not offline.',
  },
  'sources.web.enabled': {
    tag: 'network',
    on: (v) => v === true,
    note: 'Fetches pages from the allowed domains over the network in runs that are not offline.',
  },
  'sandbox.allowNetworkWithoutIsolation': {
    tag: 'network',
    on: (v) => v === true,
    note: 'Project code runs even where its network access cannot be blocked.',
  },
  'llm.provider': {
    tag: 'LLM',
    on: (v) => v !== 'none',
    note: 'Sends specification text to this provider in runs that are not offline.',
  },
  'sources.sendFullTextToLlm': {
    tag: 'LLM',
    on: (v) => v === true,
    note: 'Sends whole documents to the LLM instead of the relevant excerpts.',
  },
  'llm.allowCodexFileReads': {
    tag: 'LLM',
    on: (v) => v === true,
    note: 'Lets the codex provider, whose shell can read local files, be used.',
  },
};

/** A value as it is shown in the list. */
export function show(value: unknown, field?: ConfigField): string {
  if (value === undefined) return '(unset)';
  if (value === null) return '(none)';
  if (field?.type === 'boolean' || typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length === 0 ? '(empty)' : value.join(', ');
  if (typeof value === 'string') return value;

  return JSON.stringify(value);
}

/** A value as it is shown in the change review: JSON, so that the type is visible. */
const json = (value: unknown) => (value === undefined ? '(unset)' : JSON.stringify(value));

function allowed(field: ConfigField): string {
  if (field.type === 'fixed') return `fixed to ${json(field.fixed)}`;
  if (field.options) return `one of ${field.options.join(', ')}`;
  if (field.items?.options) return `any of ${field.items.options.join(', ')}`;
  const parts = [
    field.type === 'integer' ? 'whole number' : field.type === 'number' ? 'number' : '',
    field.exclusiveMinimum !== undefined ? `> ${field.exclusiveMinimum}` : '',
    field.minimum !== undefined ? `>= ${field.minimum}` : '',
    field.maximum !== undefined ? `<= ${field.maximum}` : '',
    field.type === 'array'
      ? `list of text${field.items?.pattern ? ` matching ${field.items.pattern}` : ''}${field.minItems ? `, at least ${field.minItems}` : ''}`
      : '',
    field.nullable ? 'empty for none' : '',
    field.default === undefined && field.type !== 'array' ? 'empty to unset' : '',
  ];

  return parts.filter(Boolean).join(', ');
}

type Row = { kind: 'section'; section: ConfigSection } | { kind: 'field'; field: ConfigField };

type Mode =
  | { kind: 'browse' }
  | { kind: 'text'; field: ConfigField }
  | { kind: 'pick'; field: ConfigField; index: number }
  | { kind: 'list'; field: ConfigField; index: number; input: 'none' | 'add' | 'edit' }
  | { kind: 'review' }
  | { kind: 'discard' }
  | { kind: 'problems' };

export function Settings({ api, active, onBack, onChange, height, width, version, setHints }: ScreenProps) {
  const config = useLoad(() => api.readConfig(), [version]);
  const data = config.data;
  const saved = data?.kind === 'json' ? data.raw : undefined;
  const [draft, setDraft] = useState<unknown>(saved);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });
  const [errors, setErrors] = useState<{ path: string; messages: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const listBox = useRef<DOMElement>(null);
  const listRows = Math.max(1, useBoxMetrics(listBox).height);

  // A reload (after saving, or a change elsewhere) starts again from the file.
  useEffect(() => {
    setDraft(saved);
    setErrors(null);
  }, [saved]);

  const rows: Row[] = SECTIONS.flatMap((section) => [
    { kind: 'section' as const, section },
    ...(open.has(section.key) ? section.fields.map((field) => ({ kind: 'field' as const, field })) : []),
  ]);
  const at = Math.min(cursor, rows.length - 1);
  const row = rows[at];
  const changes = data?.kind === 'json' ? diff(saved, draft) : [];

  const editable = !config.error && data?.kind === 'json';
  const problems = editable ? validate(draft) : [];
  const problemKey: Hints = problems.length ? [['p', 'problems']] : [];
  const hints: Hints = !editable
    ? [['Esc', 'back']]
    : mode.kind === 'text'
      ? [
          ['Enter', 'apply'],
          ['Esc', 'cancel'],
        ]
      : mode.kind === 'pick'
        ? [
            ['↑↓', 'choose'],
            ['Enter', 'apply'],
            ['Esc', 'cancel'],
          ]
        : mode.kind === 'list'
          ? mode.field.items?.type === 'enum'
            ? [
                ['↑↓', 'move'],
                ['Space', 'turn on/off'],
                ['Esc', 'done'],
              ]
            : [
                ['↑↓', 'move'],
                ['a', 'add'],
                ['Enter', 'edit'],
                ['d', 'delete'],
                ['Esc', 'done'],
              ]
          : mode.kind === 'review'
            ? [
                ['↑↓', 'scroll'],
                ['y', 'yes'],
                ['n', 'no'],
              ]
            : mode.kind === 'discard'
              ? [
                  ['y', 'yes'],
                  ['n', 'no'],
                ]
              : mode.kind === 'problems'
                ? [
                    ['↑↓', 'scroll'],
                    ['Esc', 'back to the settings'],
                  ]
                : row?.kind === 'section'
                  ? [
                      ['↑↓', 'move'],
                      ['Enter', open.has(row.section.key) ? 'close' : 'open'],
                      ['s', 'review & save'],
                      ...problemKey,
                      ['Esc', 'back'],
                    ]
                  : [
                      ['↑↓', 'move'],
                      ['Enter', 'change'],
                      ['r', 'reset'],
                      ['s', 'review & save'],
                      ...problemKey,
                      ['Esc', 'back'],
                    ];
  const hintKey = JSON.stringify(hints);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the hints are compared by their text
  useEffect(() => {
    if (active) setHints(hints);
  }, [active, hintKey, setHints]);

  /**
   * Apply an edit to the draft unless it adds a problem the configuration did not have; otherwise show why at the
   * field. A file that already has problems can so be fixed one setting at a time; saving waits until it is valid.
   */
  const apply = (field: ConfigField, edited: unknown): boolean => {
    const next = tidy(saved, edited, field);
    const before = new Set(validate(draft));
    const added = validate(next).filter((i) => !before.has(i));

    if (added.length) {
      setErrors({ path: key(field), messages: added });

      return false;
    }
    setErrors(null);
    setMessage(null);
    setDraft(next);

    return true;
  };

  const change = (field: ConfigField) => {
    setErrors(null);
    setMessage(null);
    if (field.type === 'fixed')
      setMessage(`${key(field)} is fixed to ${json(field.fixed)} and cannot be changed.`);
    else if (field.type === 'boolean') apply(field, setField(draft, field, !effective(draft, field)));
    else if (field.type === 'enum')
      setMode({
        kind: 'pick',
        field,
        index: Math.max(0, field.options?.indexOf(String(effective(draft, field))) ?? 0),
      });
    else if (field.type === 'array') setMode({ kind: 'list', field, index: 0, input: 'none' });
    else setMode({ kind: 'text', field });
  };

  const leave = () => {
    if (changes.length) setMode({ kind: 'discard' });
    else onBack();
  };

  useInput(
    (input, k) => {
      if (!row) return;
      if (k.upArrow || input === 'k') setCursor(Math.max(0, at - 1));
      else if (k.downArrow || input === 'j') setCursor(Math.min(rows.length - 1, at + 1));
      else if (k.escape) leave();
      else if (input === 'p' && problems.length) setMode({ kind: 'problems' });
      else if (input === 's') {
        if (problems.length)
          setMessage(
            `Fix ${problems.length} problem${problems.length === 1 ? '' : 's'} before saving: ${problems[0]}`,
          );
        else if (changes.length) setMode({ kind: 'review' });
        else setMessage('No unsaved changes.');
      } else if (row.kind === 'section') {
        const isOpen = open.has(row.section.key);
        const toggle = (on: boolean) =>
          setOpen((o) => {
            const next = new Set(o);
            if (on) next.add(row.section.key);
            else next.delete(row.section.key);
            return next;
          });

        if (k.return || input === ' ') toggle(!isOpen);
        else if (k.rightArrow) toggle(true);
        else if (k.leftArrow) toggle(false);
      } else {
        const field = row.field;

        if (k.return) change(field);
        else if (input === ' ' && field.type === 'boolean') change(field);
        else if (input === 'r') {
          if (getAt(draft, field.path) === undefined && !changed(draft, field))
            setMessage(`${key(field)} already uses its default.`);
          else apply(field, resetField(draft, field));
        } else if (k.leftArrow) {
          // Back to the section header, closing the section.
          const header = rows.findIndex((r) => r.kind === 'section' && r.section.key === sectionOf(field));
          setOpen((o) => {
            const next = new Set(o);
            next.delete(sectionOf(field));
            return next;
          });
          setCursor(Math.max(0, header));
        }
      }
    },
    { isActive: active && mode.kind === 'browse' && editable },
  );

  useInput(
    (_input, k) => {
      if (k.escape) onBack();
    },
    // Also when the file cannot be read: the way back must never depend on the file being valid.
    { isActive: active && (Boolean(config.error) || (data !== undefined && data.kind !== 'json')) },
  );

  if (config.error)
    return (
      <Card title="Settings" right={<Badge color="red">cannot read</Badge>} color="red">
        <ErrorView error={config.error} />
        <Text wrap="wrap">
          Fix .veritas/config.json in your editor (or remove it and create it again from Home), then open
          Settings again.
        </Text>
      </Card>
    );
  if (!data) return <Text dimColor>loading…</Text>;
  if (data.kind === 'none')
    return (
      <Card title="Settings">
        <Text>No configuration yet. Create one from Home (press Esc, then 1).</Text>
      </Card>
    );
  if (data.kind === 'code') {
    const file = path.relative(api.root, data.file) || data.file;

    return (
      <Card title="Settings" right={<Badge color="yellow">read-only</Badge>} color="yellow">
        <Text>{file} is a code configuration.</Text>
        <Text wrap="wrap">
          Loading it would run project code, so the TUI neither reads nor changes it. Edit {file} in your
          editor; veritas uses it as before.
        </Text>
        <Text dimColor wrap="wrap">
          Only .veritas/config.json can be edited here. The TUI never writes a code configuration.
        </Text>
      </Card>
    );
  }

  const file = path.relative(api.root, data.file) || data.file;

  if (mode.kind === 'review')
    return (
      <Review
        file={file}
        changes={changes}
        active={active}
        height={height}
        onNo={() => setMode({ kind: 'browse' })}
        onYes={() => {
          try {
            api.writeConfig(draft);
            setMessage(`Saved ${changes.length} change${changes.length === 1 ? '' : 's'} to ${file}.`);
            setSaveError(null);
            onChange();
          } catch (e) {
            setSaveError(e);
          }
          setMode({ kind: 'browse' });
        }}
      />
    );

  // Rows drawn besides the list and the panel: the problems banner above, and the message and save error below
  // (an error line may wrap to two). The list editor must leave them room.
  const reserved =
    (problems.length ? 1 : 0) + (message ? 1 : 0) + (saveError ? errorText(saveError).length * 2 : 0);

  if (mode.kind === 'problems')
    return (
      <Problems
        problems={problems}
        active={active}
        height={height}
        onClose={() => setMode({ kind: 'browse' })}
      />
    );

  const start = Math.max(0, Math.min(at - Math.floor(listRows / 2), rows.length - listRows));
  const visible = rows.slice(start, start + listRows);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold>Settings </Text>
        <Text dimColor wrap="truncate-start">
          {file}
        </Text>
        {changes.length ? (
          <Box marginLeft={1} flexShrink={0}>
            <Badge color="magenta">{`${changes.length} unsaved`}</Badge>
          </Box>
        ) : null}
      </Box>
      {problems.length ? (
        <Box flexShrink={0}>
          <Text color="yellow" wrap="truncate-end">
            {problems.length} problem{problems.length === 1 ? '' : 's'} to fix before saving (p lists them):{' '}
            {problems[0]}
          </Text>
        </Box>
      ) : null}
      <Box ref={listBox} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        {visible.map((r, i) => (
          <RowView
            key={r.kind === 'section' ? `s-${r.section.key}` : `f-${key(r.field)}`}
            row={r}
            selected={start + i === at}
            open={r.kind === 'section' && open.has(r.section.key)}
            saved={saved}
            draft={draft}
            labelWidth={Math.max(14, Math.min(34, Math.floor((width - 4) * 0.45)))}
          />
        ))}
      </Box>
      <Box flexShrink={0} flexDirection="column">
        {mode.kind === 'discard' ? (
          <Card title="Unsaved changes" color="magenta">
            <Confirm
              active={active}
              question={`Discard ${changes.length} unsaved change${changes.length === 1 ? '' : 's'} and leave?`}
              onYes={() => {
                setDraft(saved);
                setErrors(null);
                setMode({ kind: 'browse' });
                onBack();
              }}
              onNo={() => setMode({ kind: 'browse' })}
            />
          </Card>
        ) : row?.kind === 'field' ? (
          <FieldPanel
            field={row.field}
            draft={draft}
            saved={saved}
            mode={mode}
            active={active}
            errors={errors?.path === key(row.field) ? errors.messages : []}
            onCancel={() => {
              setErrors(null);
              setMode({ kind: 'browse' });
            }}
            onApply={(next) => apply(row.field, next)}
            onError={(messages) => setErrors({ path: key(row.field), messages })}
            onMode={setMode}
            height={height - reserved}
          />
        ) : row?.kind === 'section' ? (
          <Card title={sectionTitle(row.section)}>
            <Text wrap="wrap">{row.section.description}</Text>
            <Text dimColor>
              {row.section.fields.length} setting{row.section.fields.length === 1 ? '' : 's'},{' '}
              {row.section.fields.filter((f) => changed(draft, f)).length} not at the default
            </Text>
          </Card>
        ) : null}
        {message ? (
          <Text color={message.startsWith('Saved') ? 'green' : 'yellow'} wrap="truncate-end">
            {message}
          </Text>
        ) : null}
        {saveError ? <ErrorView error={saveError} /> : null}
      </Box>
    </Box>
  );
}

function sectionOf(field: ConfigField): string {
  return field.path.length > 1 ? (field.path[0] ?? '') : '';
}

function EffectTag({ field, value }: { field: ConfigField; value: unknown }) {
  const effect = EFFECTS[key(field)];

  if (!effect) return null;

  return (
    <Box flexShrink={0} marginLeft={1}>
      <Badge color={effect.on(value) ? 'yellow' : 'gray'}>{effect.tag}</Badge>
    </Box>
  );
}

function RowView({
  row,
  selected,
  open,
  saved,
  draft,
  labelWidth,
}: {
  row: Row;
  selected: boolean;
  open: boolean;
  saved: unknown;
  draft: unknown;
  labelWidth: number;
}) {
  const pointer = (
    <Box flexShrink={0} width={2}>
      <Text color="cyan">{selected ? '›' : ' '}</Text>
    </Box>
  );

  if (row.kind === 'section') {
    const s = row.section;
    const differs = s.fields.filter((f) => changed(draft, f)).length;
    const unsaved = s.fields.filter((f) => !same(getAt(saved, f.path), getAt(draft, f.path))).length;
    const effects = s.fields.filter((f) => EFFECTS[key(f)]?.on(effective(draft, f)));

    return (
      <Box height={1} overflow="hidden">
        {pointer}
        <Box flexShrink={0}>
          <Text bold {...(selected ? { color: 'cyan' } : {})}>
            {open ? '▾' : '▸'} {sectionTitle(s)}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {'  '}
          {s.fields.length} setting{s.fields.length === 1 ? '' : 's'}
          {differs ? <Text color="yellow"> {differs} changed</Text> : null}
          {unsaved ? <Text color="magenta"> {unsaved} unsaved</Text> : null}
          {effects.length ? (
            <Text color="yellow">
              {' '}
              {[...new Set(effects.map((f) => EFFECTS[key(f)]?.tag))].join(', ')} on
            </Text>
          ) : null}
        </Text>
      </Box>
    );
  }
  const f = row.field;
  const value = effective(draft, f);
  const differs = changed(draft, f);
  const unsaved = !same(getAt(saved, f.path), getAt(draft, f.path));

  return (
    <Box height={1} overflow="hidden">
      {pointer}
      <Box flexShrink={0} width={2}>
        <Text color="magenta">{unsaved ? '*' : ' '}</Text>
      </Box>
      <Box width={labelWidth} flexShrink={0} overflow="hidden" marginRight={1}>
        <Text wrap="truncate-end" {...(selected ? { color: 'cyan' } : {})}>
          {fieldLabel(f)}
        </Text>
      </Box>
      <Box flexGrow={1} flexBasis={0} overflow="hidden">
        <Text
          wrap="truncate-end"
          {...(f.type === 'fixed' || getAt(draft, f.path) === undefined ? { dimColor: true } : {})}
          {...(differs ? { color: 'yellow' } : {})}
        >
          {show(value, f)}
        </Text>
      </Box>
      <EffectTag field={f} value={value} />
      <Box flexShrink={0} width={8} marginLeft={1}>
        {differs ? (
          <Text color="yellow">changed</Text>
        ) : f.type === 'fixed' ? (
          <Text dimColor>fixed</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function FieldPanel({
  field,
  draft,
  saved,
  mode,
  active,
  errors,
  onCancel,
  onApply,
  onError,
  onMode,
  height,
}: {
  field: ConfigField;
  draft: unknown;
  saved: unknown;
  mode: Mode;
  active: boolean;
  errors: string[];
  onCancel: () => void;
  onError: (messages: string[]) => void;
  onApply: (next: unknown) => boolean;
  onMode: (mode: Mode) => void;
  /** Rows of the whole Settings screen, which the list editor must fit in. */
  height: number;
}) {
  const value = effective(draft, field);
  const written = getAt(draft, field.path);
  const effect = EFFECTS[key(field)];
  const unsaved = !same(getAt(saved, field.path), written);
  const editing = mode.kind !== 'browse' && 'field' in mode && key(mode.field) === key(field);

  return (
    <Card
      title={fieldLabel(field)}
      color={editing ? 'cyan' : errors.length ? 'red' : 'gray'}
      right={
        <Text dimColor wrap="truncate-start">
          {key(field)}
        </Text>
      }
    >
      {/* While a value is changed, the description keeps to one line to leave room for the editor. */}
      <Text wrap={editing ? 'truncate-end' : 'wrap'}>{field.description}</Text>
      <Text wrap="truncate-end">
        <Text dimColor>now </Text>
        <Text {...(changed(draft, field) ? { color: 'yellow' } : {})}>{show(value, field)}</Text>
        {written === undefined && field.default !== undefined ? <Text dimColor> (default)</Text> : null}
        <Text dimColor>{'   default '}</Text>
        {show(field.default, field)}
        {unsaved ? <Text color="magenta">{'   unsaved'}</Text> : null}
      </Text>
      {allowed(field) && mode.kind !== 'pick' ? (
        <Text dimColor wrap="truncate-end">
          allowed: {allowed(field)}
        </Text>
      ) : null}
      {effect ? (
        <Text color="yellow" wrap="wrap">
          {effect.tag === 'network' ? 'Network: ' : 'LLM: '}
          {effect.note} Off by default.
        </Text>
      ) : null}
      {editing && mode.kind === 'text' ? (
        <TextInput
          active={active}
          label="New value:"
          initial={written === undefined || written === null ? '' : String(written)}
          errors={errors}
          hint="Enter to apply, Esc to cancel"
          onCancel={onCancel}
          onSubmit={(text) => {
            const parsed = parseText(text, field);

            if ('error' in parsed) {
              onError([parsed.error]);

              return;
            }
            const next =
              parsed.value === UNSET ? unsetAt(draft, field.path) : setField(draft, field, parsed.value);

            if (onApply(next)) onMode({ kind: 'browse' });
          }}
        />
      ) : null}
      {editing && mode.kind === 'pick' ? (
        <Picker
          field={field}
          index={mode.index}
          active={active}
          draft={draft}
          onApply={onApply}
          onMode={onMode}
        />
      ) : null}
      {editing && mode.kind === 'list' ? (
        <ListEditor
          field={field}
          mode={mode}
          active={active}
          draft={draft}
          errors={errors}
          onApply={onApply}
          onMode={onMode}
          height={height}
        />
      ) : null}
      {!editing || mode.kind === 'pick' || (mode.kind === 'list' && mode.input === 'none')
        ? errors.map((e) => (
            <Text key={e} color="red" wrap="wrap">
              {e}
            </Text>
          ))
        : null}
    </Card>
  );
}

function Picker({
  field,
  index,
  active,
  draft,
  onApply,
  onMode,
}: {
  field: ConfigField;
  index: number;
  active: boolean;
  draft: unknown;
  onApply: (next: unknown) => boolean;
  onMode: (mode: Mode) => void;
}) {
  const options = field.options ?? [];
  const current = effective(draft, field);

  useInput(
    (input, k) => {
      if (k.escape) onMode({ kind: 'browse' });
      else if (k.upArrow || input === 'k') onMode({ kind: 'pick', field, index: Math.max(0, index - 1) });
      else if (k.downArrow || input === 'j')
        onMode({ kind: 'pick', field, index: Math.min(options.length - 1, index + 1) });
      else if (k.return || input === ' ') {
        const choice = options[index];

        if (choice !== undefined && onApply(setField(draft, field, choice))) onMode({ kind: 'browse' });
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Choose a value:</Text>
      {options.map((o, i) => (
        <Text key={o} {...(i === index ? { color: 'cyan' } : {})}>
          {i === index ? '› ' : '  '}
          {o}
          {o === current ? <Text dimColor> (now)</Text> : null}
          {o === field.default ? <Text dimColor> (default)</Text> : null}
          {EFFECTS[key(field)]?.on(o) ? <Text color="yellow"> uses {EFFECTS[key(field)]?.tag}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function ListEditor({
  field,
  mode,
  active,
  draft,
  errors,
  onApply,
  onMode,
  height,
}: {
  field: ConfigField;
  mode: Extract<Mode, { kind: 'list' }>;
  active: boolean;
  draft: unknown;
  errors: string[];
  onApply: (next: unknown) => boolean;
  onMode: (mode: Mode) => void;
  height: number;
}) {
  const choices = field.items?.type === 'enum' ? (field.items.options ?? []) : null;
  const value = effective(draft, field);
  const items = Array.isArray(value) ? value.map(String) : [];
  const rows = choices ?? items;
  const index = Math.min(mode.index, Math.max(0, rows.length - 1));
  const write = (next: string[]) => onApply(setField(draft, field, next));
  // Entries shown at once: the screen less the settings above the panel, the panel's own lines, the line that says
  // which entries are shown and, while an entry is typed, the field with its errors (each may take two lines).
  const typing = mode.input !== 'none' ? 3 + errors.length * 2 : 0;
  const fit = Math.max(1, height - LIST_CHROME - typing);
  const first = Math.max(0, Math.min(index - Math.floor(fit / 2), rows.length - fit));
  const shown = numbered(rows).slice(first, first + fit);

  useInput(
    (input, k) => {
      if (k.escape) onMode({ kind: 'browse' });
      else if (k.upArrow || input === 'k') onMode({ ...mode, index: Math.max(0, index - 1) });
      else if (k.downArrow || input === 'j') onMode({ ...mode, index: Math.min(rows.length - 1, index + 1) });
      else if (choices) {
        const choice = choices[index];

        if ((input === ' ' || k.return) && choice !== undefined)
          write(items.includes(choice) ? items.filter((i) => i !== choice) : [...items, choice]);
      } else if (input === 'a') onMode({ ...mode, input: 'add' });
      else if (k.return && items.length) onMode({ ...mode, input: 'edit' });
      else if ((input === 'd' || k.delete || k.backspace) && items.length)
        write(items.filter((_, i) => i !== index));
    },
    { isActive: active && mode.input === 'none' },
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.length === 0 ? <Text dimColor>(empty: press a to add an entry)</Text> : null}
      {/* Entries can repeat while a list is edited; the position tells them apart. */}
      {shown.map(({ key: rowKey, n: i, text: r }) => (
        <Text key={rowKey} wrap="truncate-end" {...(i === index ? { color: 'cyan' } : {})}>
          {i === index ? '› ' : '  '}
          {choices ? (items.includes(r) ? '[x] ' : '[ ] ') : ''}
          {r}
        </Text>
      ))}
      {rows.length > fit ? (
        <Text dimColor>
          entries {first + 1}-{first + shown.length} of {rows.length}, ↑↓ to move
        </Text>
      ) : null}
      {mode.input !== 'none' ? (
        <TextInput
          active={active}
          label={mode.input === 'add' ? 'New entry:' : 'Change the entry:'}
          initial={mode.input === 'edit' ? (items[index] ?? '') : ''}
          errors={errors}
          onCancel={() => onMode({ ...mode, input: 'none' })}
          onSubmit={(text) => {
            const entry = text.trim();
            const next =
              mode.input === 'add' ? [...items, entry] : items.map((item, i) => (i === index ? entry : item));

            if (entry && write(next))
              onMode({ ...mode, input: 'none', index: mode.input === 'add' ? next.length - 1 : index });
          }}
        />
      ) : null}
    </Box>
  );
}

/**
 * Rows around the entries of the list editor: the settings title and at least one row of the list above the panel,
 * the panel's border, title, description, current value, allowed values and gap, and the line under the entries.
 */
const LIST_CHROME = 10;

/** Every schema problem of the edited configuration, scrolled when they do not fit. */
function Problems({
  problems,
  active,
  height,
  onClose,
}: {
  problems: string[];
  active: boolean;
  height: number;
  onClose: () => void;
}) {
  useInput(
    (input, k) => {
      if (k.escape || input === 'p') onClose();
    },
    { isActive: active },
  );
  const unknown = problems.some((p) => /unrecognized key/i.test(p));

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text bold color="yellow">
        {problems.length} problem{problems.length === 1 ? '' : 's'} to fix before saving
      </Text>
      <Text dimColor wrap="wrap">
        Saving waits until there are none. An edit is accepted when it adds no new problem.
        {unknown ? ' Keys the schema does not know cannot be shown here: remove them in your editor.' : ''}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {/* The title, a note of up to three lines and the gap above the list. */}
        <ScrollView active={active} height={Math.max(1, height - 6)}>
          {numbered(problems).map((p) => (
            <Text key={p.key} wrap="wrap">
              {p.text}
            </Text>
          ))}
        </ScrollView>
      </Box>
    </Box>
  );
}

/** Rows the review keeps for its title, the line under the list and the question. */
const REVIEW_CHROME = 5;
/** Rows of one change in the review: its path, the value before and the value after. */
const CHANGE_ROWS = 3;

/**
 * Every change before it is saved, scrolled with ↑/↓ when they do not all fit. `y` saves only once the last change
 * has been on the screen, so nothing is written unseen.
 */
function Review({
  file,
  changes,
  active,
  height,
  onYes,
  onNo,
}: {
  file: string;
  changes: Change[];
  active: boolean;
  height: number;
  onYes: () => void;
  onNo: () => void;
}) {
  const fit = Math.max(1, Math.floor((height - REVIEW_CHROME) / CHANGE_ROWS));
  const [top, setTop] = useState(0);
  const [seenAll, setSeenAll] = useState(changes.length <= fit);
  const [notice, setNotice] = useState(false);
  const max = Math.max(0, changes.length - fit);
  const shown = changes.slice(top, top + fit);
  const below = changes.length - top - shown.length;
  const side = (value: unknown, field: ConfigField) =>
    value === undefined ? `(unset, default ${json(field.default)})` : json(value);

  useInput(
    (input, k) => {
      if (k.upArrow || input === 'k') setTop(Math.max(0, top - 1));
      else if (k.downArrow || input === 'j' || k.pageDown || input === ' ') {
        const next = Math.min(max, top + (k.pageDown || input === ' ' ? fit : 1));

        setTop(next);
        if (next >= max) setSeenAll(true);
      } else if (input === 'y' || input === 'Y') {
        if (seenAll) onYes();
        else setNotice(true);
      } else if (input === 'n' || input === 'N' || k.escape) onNo();
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Text bold wrap="truncate-end">
        Review {changes.length} change{changes.length === 1 ? '' : 's'} to {file}
      </Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" marginTop={1}>
        {shown.map((c) => {
          const effect = EFFECTS[c.path];

          return (
            <Box key={c.path} flexDirection="column" flexShrink={0}>
              <Box>
                <Text wrap="truncate-end">
                  {c.path}
                  <Text dimColor> {fieldLabel(c.field)}</Text>
                </Text>
                {effect?.on(c.after === undefined ? c.field.default : c.after) ? (
                  <Box flexShrink={0} marginLeft={1}>
                    <Badge color="yellow">{`turns on ${effect.tag}`}</Badge>
                  </Box>
                ) : null}
              </Box>
              <Text color="red" wrap="truncate-end">
                {'  - '}
                {side(c.before, c.field)}
              </Text>
              <Text color="green" wrap="truncate-end">
                {'  + '}
                {side(c.after, c.field)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box flexShrink={0} flexDirection="column">
        {below > 0 ? (
          <Text color="cyan">+{below} more (↓)</Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            Only {file} is written, after it is checked against the schema again.
          </Text>
        )}
        {notice && !seenAll ? (
          <Text color="yellow">Scroll to the last change (↓) before saving.</Text>
        ) : (
          <Text>
            Save {changes.length === 1 ? 'this change' : `these ${changes.length} changes`}?{' '}
            <Text color="cyan">{seenAll ? '[y/N]' : '[↓ to see all, then y/N]'}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
