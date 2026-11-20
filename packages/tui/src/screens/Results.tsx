import type { Finding } from '@under18dev/veritas-core';
import { explanationLines } from '@under18dev/veritas-engine';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { ErrorView, Pager, SelectList, Title, useLoad } from '../components.js';
import type { ScreenProps } from '../screen.js';

type View =
  | { kind: 'runs' }
  | { kind: 'run'; runId: string }
  | { kind: 'finding'; runId: string; finding: Finding };

export function Results({ api, active, onBack, height, version }: ScreenProps) {
  const [view, setView] = useState<View>({ kind: 'runs' });
  const runs = useLoad(() => api.runs().map((id) => ({ id, run: safe(() => api.readRun(id)) })), [version]);

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (view.kind === 'runs') onBack();
      else if (view.kind === 'run') setView({ kind: 'runs' });
      else setView({ kind: 'run', runId: view.runId });
    },
    { isActive: active },
  );

  if (view.kind === 'run')
    return (
      <RunDetail
        {...{ api, active, height }}
        runId={view.runId}
        onOpen={(finding) => setView({ kind: 'finding', runId: view.runId, finding })}
      />
    );
  if (view.kind === 'finding') return <FindingDetail {...{ api, active, height }} finding={view.finding} />;

  return (
    <Box flexDirection="column">
      <Title>Results</Title>
      {runs.error ? <ErrorView error={runs.error} /> : null}
      {runs.data?.length === 0 ? <Text>No run yet. Start one from Run.</Text> : null}
      <SelectList
        active={active}
        height={height - 2}
        items={(runs.data ?? []).map(({ id, run }) => ({
          label: id,
          value: id,
          hint: run
            ? `${run.command} ${run.profile ?? ''} · ${run.verdict ?? run.status} · exit ${run.exitCode ?? '-'}`
            : '(unreadable)',
        }))}
        onSelect={(item) => setView({ kind: 'run', runId: item.value })}
      />
    </Box>
  );
}

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function RunDetail({
  api,
  active,
  height,
  runId,
  onOpen,
}: Pick<ScreenProps, 'api' | 'active' | 'height'> & { runId: string; onOpen: (f: Finding) => void }) {
  const data = useLoad(() => ({ run: api.readRun(runId), findings: api.readFindings(runId) }), [runId]);

  if (data.error) return <ErrorView error={data.error} />;
  if (!data.data) return <Text dimColor>loading…</Text>;
  const { run, findings } = data.data;

  return (
    <Box flexDirection="column">
      <Title>{`Run ${run.id}`}</Title>
      <Text>
        {run.command} {run.profile ?? ''} · {run.verdict ?? run.status} · exit {run.exitCode ?? '-'} ·{' '}
        {run.startedAt}
      </Text>
      {run.policyReasons.map((r) => (
        <Text key={r} dimColor>
          {r}
        </Text>
      ))}
      <Text>
        stages:{' '}
        {run.stages.map((s) => (
          <Text
            key={s.stage}
            color={s.status === 'succeeded' ? 'green' : s.status === 'skipped' ? 'gray' : 'yellow'}
          >
            {s.stage}:{s.status}{' '}
          </Text>
        ))}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Findings ({findings.length})</Text>
        <SelectList
          active={active}
          height={Math.max(3, height - 6)}
          items={findings.map((f) => ({
            label: `${f.severity.padEnd(7)} ${f.title}`,
            value: f,
            hint: f.kind,
          }))}
          onSelect={(item) => onOpen(item.value)}
        />
      </Box>
    </Box>
  );
}

function FindingDetail({
  api,
  active,
  height,
  finding,
}: Pick<ScreenProps, 'api' | 'active' | 'height'> & { finding: Finding }) {
  const data = useLoad(() => api.explain(finding.id), [finding.id]);

  return (
    <Box flexDirection="column">
      <Title>{`Finding ${finding.id}`}</Title>
      {data.error ? <ErrorView error={data.error} /> : null}
      {data.data ? <Pager active={active} height={height - 2} lines={explanationLines(data.data)} /> : null}
    </Box>
  );
}
