import type { Approval, Property } from '@under18dev/veritas-core';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { ErrorView, Pager, SelectList, TextInput, Title, useLoad } from '../components.js';
import type { ScreenProps } from '../screen.js';

const FILTERS = ['all', 'proposed', 'reviewed', 'accepted', 'rejected', 'conflicted', 'superseded'] as const;

export function propertyLines(p: Property, approvals: Approval[], others: Property[]): string[] {
  const lines = [
    `${p.id} v${p.version}  [${p.status}]  ${p.template}`,
    p.description,
    '',
    `targets: ${p.targetSymbols.join(', ') || '-'}`,
    `origin: ${p.origin}  implementation agrees: ${p.implementationAgreement}`,
    // The evidence vector, field by field: there is no single confidence score.
    `evidence: ${Object.entries(p.confidence)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    ...(p.formalExpression ? [`formal: ${p.formalExpression}`] : []),
    ...(p.assumptions.length ? ['assumptions:', ...p.assumptions.map((a) => `  ${a}`)] : []),
    ...(p.citations.length ? ['', 'cited text:', ...p.citations.map((c) => `  "${c}"`)] : []),
  ];

  if (p.conflictsWith.length) {
    lines.push('', 'conflicts with:');
    for (const id of p.conflictsWith) {
      const o = others.find((x) => x.id === id);
      lines.push(`  ${id} [${o?.status ?? '?'}] ${o?.description ?? ''}`);
      for (const c of o?.citations ?? []) lines.push(`      "${c}"`);
    }
  }
  if (approvals.length) {
    lines.push('', 'decisions:');
    for (const a of approvals) lines.push(`  ${a.decidedAt} ${a.decision} by ${a.actor}: ${a.reason}`);
  }

  return lines;
}

type View =
  | { kind: 'list' }
  | { kind: 'diff' }
  | { kind: 'detail'; id: string }
  | { kind: 'reason'; id: string; decision: 'accept' | 'reject' };

export function Spec({ api, active, onBack, onChange, height, version }: ScreenProps) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [filter, setFilter] = useState(0);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const props = useLoad(() => api.properties(), [version]);
  const all = props.data ?? [];
  const status = FILTERS[filter] ?? 'all';
  const shown = status === 'all' ? all : all.filter((p) => p.status === status);

  useInput(
    (input, key) => {
      if (view.kind === 'reason') return;
      if (key.escape) {
        setMessage(null);
        setError(null);
        if (view.kind === 'list') onBack();
        else setView({ kind: 'list' });
      } else if (view.kind === 'list' && input === 'f') setFilter((f) => (f + 1) % FILTERS.length);
      else if (view.kind === 'list' && input === 'd') setView({ kind: 'diff' });
      else if (view.kind === 'detail' && (input === 'a' || input === 'r')) {
        setMessage(null);
        setView({ kind: 'reason', id: view.id, decision: input === 'a' ? 'accept' : 'reject' });
      }
    },
    { isActive: active },
  );

  if (view.kind === 'diff') return <DiffView api={api} active={active} height={height} />;
  if (view.kind === 'detail' || view.kind === 'reason') {
    let detail: ReturnType<typeof api.property> | null = null;
    let readError: unknown = null;
    try {
      detail = api.property(view.id);
    } catch (e) {
      readError = e;
    }

    return (
      <Box flexDirection="column">
        <Title>{`Property ${view.id}`}</Title>
        {readError ? <ErrorView error={readError} /> : null}
        {view.kind === 'reason' ? (
          <TextInput
            active={active}
            label={`Reason to ${view.decision} ${view.id} (required; recorded with your name):`}
            onCancel={() => setView({ kind: 'detail', id: view.id })}
            onSubmit={(reason) => {
              if (reason.trim() === '') {
                setMessage({ text: 'A reason is required; nothing was recorded.', error: true });
                setView({ kind: 'detail', id: view.id });
                return;
              }
              api.decide(view.id, view.decision, reason.trim()).then(
                (a) => {
                  setMessage({ text: `Recorded ${a.decision} of ${a.propertyId} by ${a.actor}.` });
                  onChange();
                },
                (e: unknown) => setError(e),
              );
              setView({ kind: 'detail', id: view.id });
            }}
          />
        ) : null}
        {message ? <Text color={message.error ? 'yellow' : 'green'}>{message.text}</Text> : null}
        {error ? <ErrorView error={error} /> : null}
        {detail && view.kind === 'detail' ? (
          <>
            <Pager
              active={active}
              height={height - 4}
              lines={propertyLines(detail.property, detail.approvals, all)}
            />
            <Text dimColor>a accept · r reject · Esc back</Text>
          </>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Title>Specifications</Title>
      <Text dimColor>
        filter (f): {status} · {shown.length} of {all.length} · d: changes since the previous run
      </Text>
      {props.error ? <ErrorView error={props.error} /> : null}
      {!props.loading && all.length === 0 ? <Text>No properties yet. Run Veritas first (Run).</Text> : null}
      <SelectList
        key={status}
        active={active}
        height={height - 3}
        items={shown.map((p) => ({
          label: `${p.status.padEnd(10)} ${p.description}`,
          value: p.id,
          hint: p.id,
        }))}
        onSelect={(item) => setView({ kind: 'detail', id: item.value })}
      />
    </Box>
  );
}

function DiffView({ api, active, height }: Pick<ScreenProps, 'api' | 'active' | 'height'>) {
  const data = useLoad(() => api.diff(), []);

  if (data.error) return <ErrorView error={data.error} />;
  if (data.loading) return <Text dimColor>loading…</Text>;
  if (!data.data) return <Text>No run with properties yet.</Text>;
  const { from, to, diff } = data.data;
  const lines = [
    `from ${from ?? '(none)'} to ${to}`,
    '',
    ...diff.added.map((p) => `+ ${p.id} ${p.description}`),
    ...diff.removed.map((p) => `- ${p.id} ${p.description}`),
    ...diff.changed.map((c) => `~ ${c.after.id} changed: ${c.fields.join(', ')}`),
    ...diff.statusChanged.map((s) => `  ${s.id} ${s.from} -> ${s.to}`),
  ];

  return (
    <Box flexDirection="column">
      <Title>Changes since the previous run</Title>
      <Pager
        active={active}
        height={height - 2}
        lines={lines.length > 2 ? lines : [...lines, 'no changes']}
      />
    </Box>
  );
}
