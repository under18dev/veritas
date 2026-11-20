import { VeritasConfig } from '@under18dev/veritas-core';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Confirm, ErrorView, SelectList, TextInput, Title, useLoad } from '../components.js';
import type { ScreenProps } from '../screen.js';

type Path = (string | number)[];

/** Every editable value of a configuration: objects are walked, anything else (including arrays) is one value. */
export function leaves(value: unknown, prefix: Path = []): { path: Path; value: unknown }[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return Object.entries(value).flatMap(([k, v]) => leaves(v, [...prefix, k]));

  return [{ path: prefix, value }];
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

/** Read an edited value: JSON when it parses (numbers, booleans, arrays), otherwise the text itself. */
export function parseValue(text: string, previous: unknown): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return typeof previous === 'string' || previous === undefined ? text : Symbol.for('invalid');
  }
}

/** Check a candidate configuration with the schema the CLI uses; returns `path: message` lines. */
export function validate(raw: unknown): string[] {
  const result = VeritasConfig.safeParse(raw);

  return result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

const show = (v: unknown) => (v === undefined ? '(unset)' : JSON.stringify(v));

type View =
  | { kind: 'list' }
  | { kind: 'edit'; path: Path; value: unknown }
  | { kind: 'confirm'; path: Path; before: unknown; after: unknown; next: unknown };

export function Settings({ api, active, onBack, onChange, height, version }: ScreenProps) {
  const config = useLoad(() => api.readConfig(), [version]);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [problems, setProblems] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useInput(
    (_input, key) => {
      if (key.escape) onBack();
    },
    { isActive: active && view.kind === 'list' },
  );

  const data = config.data;
  if (config.error) return <ErrorView error={config.error} />;
  if (!data) return <Text dimColor>loading…</Text>;
  if (data.kind === 'none')
    return (
      <Box flexDirection="column">
        <Title>Settings</Title>
        <Text>No configuration yet. Create one from Home.</Text>
      </Box>
    );
  if (data.kind === 'code')
    return (
      <Box flexDirection="column">
        <Title>Settings</Title>
        <Text>{data.file} is a code configuration.</Text>
        <Text dimColor>
          It executes project code, so it is not loaded or edited here. Edit the file directly.
        </Text>
      </Box>
    );

  const raw = data.raw;

  return (
    <Box flexDirection="column">
      <Title>{`Settings (${data.file})`}</Title>
      {view.kind === 'list' ? (
        <SelectList
          active={active}
          height={height - 5}
          items={leaves(raw).map((l) => ({ label: `${l.path.join('.')} = ${show(l.value)}`, value: l }))}
          onSelect={(item) => {
            setMessage(null);
            setProblems([]);
            setView({ kind: 'edit', path: item.value.path, value: item.value.value });
          }}
        />
      ) : null}
      {view.kind === 'edit' ? (
        <TextInput
          active={active}
          label={`New value for ${view.path.join('.')} (JSON for numbers, booleans and lists):`}
          initial={typeof view.value === 'string' ? view.value : JSON.stringify(view.value)}
          onCancel={() => setView({ kind: 'list' })}
          onSubmit={(text) => {
            const value = parseValue(text, view.value);
            if (typeof value === 'symbol') {
              setProblems([`${view.path.join('.')}: not valid JSON`]);
              return;
            }
            const next = setAt(raw, view.path, value);
            const issues = validate(next);
            setProblems(issues);
            if (issues.length === 0)
              setView({ kind: 'confirm', path: view.path, before: view.value, after: value, next });
          }}
        />
      ) : null}
      {view.kind === 'confirm' ? (
        <Box flexDirection="column">
          <Text>{view.path.join('.')}</Text>
          <Text color="red">- {show(view.before)}</Text>
          <Text color="green">+ {show(view.after)}</Text>
          <Confirm
            active={active}
            question="Save this change to the configuration?"
            onNo={() => setView({ kind: 'list' })}
            onYes={() => {
              try {
                api.writeConfig(view.next);
                setMessage(`Saved ${view.path.join('.')}.`);
                setError(null);
                onChange();
              } catch (e) {
                setError(e);
              }
              setView({ kind: 'list' });
            }}
          />
        </Box>
      ) : null}
      {problems.map((p) => (
        <Text key={p} color="yellow">
          {p}
        </Text>
      ))}
      {message ? <Text color="green">{message}</Text> : null}
      {error ? <ErrorView error={error} /> : null}
    </Box>
  );
}
