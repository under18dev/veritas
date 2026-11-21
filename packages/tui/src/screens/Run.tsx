import type { LogEvent } from '@under18dev/veritas-core';
import { PROFILE_STAGES, type Profile, type RunSummary } from '@under18dev/veritas-engine';
import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { RunRequest } from '../api.js';
import {
  Badge,
  ErrorView,
  ProgressBar,
  SelectList,
  SPINNER,
  TextInput,
  Title,
  verdictColor,
} from '../components.js';
import type { ScreenProps } from '../screen.js';

const PROFILES: Profile[] = ['quick', 'standard', 'deep'];
/** Activity lines kept while a run is in progress; older ones scroll away. */
const LOG_LIMIT = 200;
/** How often the spinner, the clocks and the activity log are redrawn. */
const FRAME_MS = 100;

export interface StageLine {
  stage: string;
  status: string;
  durationMs?: number;
}

export interface LogLine {
  id: number;
  time: string;
  level: LogEvent['level'];
  text: string;
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

/** Append run events to the activity log as `HH:MM:SS message` lines, keeping the last `limit`. */
export function appendLog(log: LogLine[], events: LogEvent[], limit = LOG_LIMIT): LogLine[] {
  if (events.length === 0) return log;
  let id = log.at(-1)?.id ?? 0;
  const added = events.map((event) => ({
    id: ++id,
    time: /T(\d\d:\d\d:\d\d)/.exec(event.time)?.[1] ?? '',
    level: event.level,
    text: event.message.replace(/\s+/g, ' ').trim(),
  }));

  return [...log, ...added].slice(-limit);
}

/** `m:ss` for a duration in milliseconds. */
export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const STAGE_MARK: Record<string, { mark: string; color: string }> = {
  succeeded: { mark: '✔', color: 'green' },
  partial: { mark: '!', color: 'yellow' },
  skipped: { mark: '-', color: 'gray' },
  cancelled: { mark: '✖', color: 'yellow' },
  timeout: { mark: '✖', color: 'yellow' },
  error: { mark: '✖', color: 'red' },
  failed: { mark: '✖', color: 'red' },
};

function StageList({
  stages,
  frame,
  now,
  startedAt,
}: {
  stages: StageLine[];
  frame: number;
  now: number;
  startedAt: Map<string, number>;
}) {
  return (
    <Box flexDirection="column">
      {stages.map((s) => {
        const running = s.status === 'running';
        const pending = s.status === 'pending';
        const { mark, color } = running
          ? { mark: SPINNER[frame % SPINNER.length] ?? '*', color: 'cyan' }
          : pending
            ? { mark: ' ', color: 'gray' }
            : (STAGE_MARK[s.status] ?? { mark: '?', color: 'yellow' });
        const started = startedAt.get(s.stage);

        return (
          <Text key={s.stage} {...(pending ? { dimColor: true } : {})}>
            <Text color={color}>{mark}</Text> {s.stage.padEnd(9)}
            {running ? (
              <Text color="cyan"> running {started ? clock(now - started) : ''}</Text>
            ) : pending ? (
              <Text> waiting</Text>
            ) : (
              <Text color={color}>
                {' '}
                {s.status}
                {s.durationMs !== undefined ? <Text dimColor> {s.durationMs} ms</Text> : null}
              </Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}

function ActivityLog({ log, rows }: { log: LogLine[]; rows: number }) {
  const visible = log.slice(-rows);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={rows + 2}>
      {visible.length === 0 ? <Text dimColor>waiting for the first event</Text> : null}
      {visible.map((line) => (
        <Text key={line.id} wrap="truncate-end">
          <Text dimColor>{line.time} </Text>
          <Text
            {...(line.level === 'error'
              ? { color: 'red' }
              : line.level === 'warn'
                ? { color: 'yellow' }
                : line.level === 'debug'
                  ? { dimColor: true }
                  : {})}
          >
            {line.text}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

type State =
  | { kind: 'form' }
  | { kind: 'since' }
  | { kind: 'running'; startedAt: number }
  /** `cancelled`: the run was cancelled and returned what it had recorded; its results are incomplete. */
  | { kind: 'done'; summary: RunSummary; durationMs: number; cancelled: boolean }
  | { kind: 'failed'; error: unknown; cancelled: boolean };

export function RunScreen({ api, active, height, onBack, onChange, navigate }: ScreenProps) {
  const [request, setRequest] = useState<RunRequest>({
    profile: 'quick',
    offline: true,
    includeProposed: false,
  });
  const [state, setState] = useState<State>({ kind: 'form' });
  const [stages, setStages] = useState<StageLine[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [now, setNow] = useState(Date.now());
  const [frame, setFrame] = useState(0);
  const controller = useRef<AbortController | null>(null);
  // Events arrive in bursts (thousands during analysis); they are buffered and drawn once per frame.
  const pending = useRef<LogEvent[]>([]);
  const stageStarts = useRef(new Map<string, number>());

  // Leaving the screen or closing the TUI cancels a run in progress.
  useEffect(() => () => controller.current?.abort(), []);

  const running = state.kind === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const events = pending.current.splice(0);
      setFrame((f) => f + 1);
      setNow(Date.now());

      if (events.length) {
        setStages((lines) => events.reduce(applyStageEvent, lines));
        setLog((lines) => appendLog(lines, events));
      }
    }, FRAME_MS);

    return () => clearInterval(timer);
  }, [running]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        if (state.kind === 'running') controller.current?.abort();
        else if (state.kind === 'form') onBack();
        else setState({ kind: 'form' });
      } else if (key.return && state.kind === 'done') navigate('results');
    },
    { isActive: active && state.kind !== 'since' },
  );

  const start = () => {
    const c = new AbortController();
    const startedAt = Date.now();
    controller.current = c;
    pending.current = [];
    stageStarts.current = new Map();
    setStages(PROFILE_STAGES[request.profile].map((stage) => ({ stage, status: 'pending' })));
    setLog([]);
    setNow(startedAt);
    setState({ kind: 'running', startedAt });
    api
      .run(request, c.signal, (event) => {
        if (event.event === 'stage' && event.at === 'start' && typeof event.stage === 'string')
          stageStarts.current.set(event.stage, Date.now());
        pending.current.push(event);
      })
      .then(
        (summary) => {
          // The stages as the run recorded them.
          setStages(
            summary.run.stages.map((s) => ({ stage: s.stage, status: s.status, durationMs: s.durationMs })),
          );
          // A cancelled run still returns a summary (its stages cancelled). The activity log, which is only for
          // watching the run, is kept for it to show where it stopped, and cleared once a run has finished.
          const cancelled = c.signal.aborted;
          const events = pending.current.splice(0);

          if (cancelled) setLog((lines) => appendLog(lines, events));
          else setLog([]);
          setState({ kind: 'done', summary, durationMs: Date.now() - startedAt, cancelled });
        },
        (error: unknown) => {
          const events = pending.current.splice(0);
          setStages((lines) => events.reduce(applyStageEvent, lines));
          setLog((lines) => appendLog(lines, events));
          setState({ kind: 'failed', error, cancelled: c.signal.aborted });
        },
      )
      .finally(() => {
        controller.current = null;
        onChange();
      });
  };

  const items = [
    {
      label: `Profile: ${request.profile}`,
      value: 'profile',
      hint: PROFILE_STAGES[request.profile].join(' > '),
    },
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
  const finished = stages.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
  // Title, progress line, stage list, a gap and the log border.
  const logRows = Math.max(3, height - stages.length - 6);

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
      {state.kind === 'running' ? (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan">{SPINNER[frame % SPINNER.length]} </Text>
            <Text bold>{request.profile}</Text>
            <Text> {clock(now - state.startedAt)} </Text>
            <ProgressBar done={finished} total={stages.length} width={20} />
            <Text dimColor>
              {' '}
              {finished}/{stages.length} stages · Esc cancels
            </Text>
          </Box>
          <Box marginTop={1}>
            <StageList stages={stages} frame={frame} now={now} startedAt={stageStarts.current} />
          </Box>
          <ActivityLog log={log} rows={logRows} />
        </Box>
      ) : null}
      {state.kind === 'done' && state.cancelled ? (
        <Box flexDirection="column">
          <Text color="yellow">Run cancelled. Its results are incomplete.</Text>
          <Text dimColor>
            {state.summary.runId} · stopped after {clock(state.durationMs)}
          </Text>
          <Box marginTop={1}>
            <StageList stages={stages} frame={0} now={0} startedAt={new Map()} />
          </Box>
          {log.length ? <ActivityLog log={log} rows={Math.min(logRows, log.length)} /> : null}
          <Text dimColor>Enter opens Results for this cancelled run · Esc returns to the form</Text>
        </Box>
      ) : null}
      {state.kind === 'done' && !state.cancelled ? (
        <Box flexDirection="column">
          <Box>
            <Badge color={verdictColor(state.summary.decision.verdict)}>
              {state.summary.decision.verdict}
            </Badge>
            <Text>
              {' '}
              exit {state.summary.decision.exitCode} · {state.summary.findings.length} finding(s) · took{' '}
              {clock(state.durationMs)}
            </Text>
          </Box>
          <Text dimColor>{state.summary.runId}</Text>
          {state.summary.decision.reasons.map((r) => (
            <Text key={r} color="yellow">
              {r}
            </Text>
          ))}
          <Box marginTop={1}>
            <StageList stages={stages} frame={0} now={0} startedAt={new Map()} />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter opens Results · Esc returns to the form</Text>
          </Box>
        </Box>
      ) : null}
      {state.kind === 'failed' ? (
        <Box flexDirection="column">
          {state.cancelled ? <Text color="yellow">Run cancelled.</Text> : <ErrorView error={state.error} />}
          {stages.some((s) => s.status !== 'pending') ? (
            <Box marginTop={1}>
              <StageList stages={stages} frame={0} now={0} startedAt={new Map()} />
            </Box>
          ) : null}
          {/* Kept after a failure: the last events show where it stopped. */}
          {log.length ? <ActivityLog log={log} rows={Math.min(logRows, log.length)} /> : null}
          <Text dimColor>Esc returns to the form.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
