import type { LogEvent } from '@under18dev/veritas-core';
import type { Profile, RunSummary } from '@under18dev/veritas-engine';
import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { RunRequest } from '../api.js';
import { ErrorView, SelectList, TextInput, Title } from '../components.js';
import type { ScreenProps } from '../screen.js';

const PROFILES: Profile[] = ['quick', 'standard', 'deep'];

interface StageLine {
  stage: string;
  status: string;
  durationMs?: number;
}

/** Fold a stage event into the per-stage progress lines. */
export function applyStageEvent(lines: StageLine[], event: LogEvent): StageLine[] {
  if (event.event !== 'stage' || typeof event.stage !== 'string') return lines;
  const status = event.at === 'start' ? 'running' : String(event.status ?? 'done');
  const next = lines.filter((l) => l.stage !== event.stage);
  const line: StageLine = {
    stage: event.stage,
    status,
    ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
  };
  const at = lines.findIndex((l) => l.stage === event.stage);

  if (at < 0) return [...lines, line];
  next.splice(at, 0, line);

  return next;
}

type State =
  | { kind: 'form' }
  | { kind: 'since' }
  | { kind: 'running' }
  | { kind: 'done'; summary: RunSummary }
  | { kind: 'failed'; error: unknown };

export function RunScreen({ api, active, onBack, onChange }: ScreenProps) {
  const [request, setRequest] = useState<RunRequest>({
    profile: 'quick',
    offline: true,
    includeProposed: false,
  });
  const [state, setState] = useState<State>({ kind: 'form' });
  const [stages, setStages] = useState<StageLine[]>([]);
  const controller = useRef<AbortController | null>(null);

  // Leaving the screen or closing the TUI cancels a run in progress.
  useEffect(() => () => controller.current?.abort(), []);

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (state.kind === 'running') controller.current?.abort();
      else if (state.kind === 'form') onBack();
      else setState({ kind: 'form' });
    },
    { isActive: active && state.kind !== 'since' },
  );

  const start = () => {
    const c = new AbortController();
    controller.current = c;
    setStages([]);
    setState({ kind: 'running' });
    api
      .run(request, c.signal, (event) => setStages((lines) => applyStageEvent(lines, event)))
      .then(
        (summary) => setState({ kind: 'done', summary }),
        (error: unknown) => setState({ kind: 'failed', error }),
      )
      .finally(() => {
        controller.current = null;
        onChange();
      });
  };

  const items = [
    { label: `Profile: ${request.profile}`, value: 'profile', hint: 'Enter to change' },
    {
      label: `Offline: ${request.offline ? 'yes' : 'no'}`,
      value: 'offline',
      hint: request.offline ? 'no network access' : 'network sources and LLM may be used, as configured',
    },
    {
      label: `Include proposed specifications: ${request.includeProposed ? 'yes' : 'no'}`,
      value: 'proposed',
      hint: 'verify proposed ones as experimental',
    },
    { label: `Since: ${request.since ?? '(whole project)'}`, value: 'since', hint: 'git ref' },
    { label: 'Start', value: 'start' },
  ];

  return (
    <Box flexDirection="column">
      <Title>Run</Title>
      {state.kind === 'form' || state.kind === 'since' ? (
        <SelectList
          active={active && state.kind === 'form'}
          items={items}
          onSelect={(item) => {
            if (item.value === 'profile')
              setRequest((r) => ({
                ...r,
                profile: PROFILES[(PROFILES.indexOf(r.profile) + 1) % PROFILES.length] ?? 'quick',
              }));
            else if (item.value === 'offline') setRequest((r) => ({ ...r, offline: !r.offline }));
            else if (item.value === 'proposed')
              setRequest((r) => ({ ...r, includeProposed: !r.includeProposed }));
            else if (item.value === 'since') setState({ kind: 'since' });
            else start();
          }}
        />
      ) : null}
      {state.kind === 'since' ? (
        <TextInput
          active={active}
          label="Analyze only changes since this git ref (empty for the whole project):"
          initial={request.since ?? ''}
          onCancel={() => setState({ kind: 'form' })}
          onSubmit={(value) => {
            const since = value.trim();
            setRequest(({ since: _drop, ...r }) => (since ? { ...r, since } : r));
            setState({ kind: 'form' });
          }}
        />
      ) : null}
      {stages.length && state.kind !== 'form' && state.kind !== 'since' ? (
        <Box flexDirection="column" marginBottom={1}>
          {stages.map((s) => (
            <Text key={s.stage}>
              <Text color={s.status === 'running' ? 'cyan' : s.status === 'succeeded' ? 'green' : 'yellow'}>
                {s.status.padEnd(10)}
              </Text>{' '}
              {s.stage}
              {s.durationMs !== undefined ? <Text dimColor> {s.durationMs} ms</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      {state.kind === 'running' ? <Text dimColor>Running… Esc cancels.</Text> : null}
      {state.kind === 'done' ? (
        <Box flexDirection="column">
          <Text>
            Run {state.summary.runId}: <Text bold>{state.summary.decision.verdict}</Text> (exit{' '}
            {state.summary.decision.exitCode}), {state.summary.findings.length} finding(s).
          </Text>
          {state.summary.decision.reasons.map((r) => (
            <Text key={r} dimColor>
              {r}
            </Text>
          ))}
          <Text dimColor>Open Results to see the findings. Esc returns to the form.</Text>
        </Box>
      ) : null}
      {state.kind === 'failed' ? (
        <Box flexDirection="column">
          <ErrorView error={state.error} />
          <Text dimColor>Esc returns to the form.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
