import { homedir } from 'node:os';
import path from 'node:path';
import type { DoctorReport, Finding, Run } from '@under18dev/veritas-core';
import { Box, Text, useInput } from 'ink';
import { type ReactNode, useEffect, useState } from 'react';
import type { ConfigFile, EvidenceVector } from '../api.js';
import {
  ago,
  Badge,
  Card,
  Confirm,
  duration,
  ErrorView,
  projectPath,
  runDuration,
  ScrollView,
  SEVERITIES,
  StageStrip,
  severityColor,
  statusColor,
  useLoad,
  verdictColor,
} from '../components.js';
import type { ScreenKey, ScreenProps } from '../screen.js';

/** Columns from which the dashboard shows its cards in two columns. */
const TWO_COLUMNS = 88;
const SHORTCUT: Record<string, ScreenKey> = {
  '2': 'results',
  '3': 'spec',
  '4': 'run',
  '5': 'improve',
  '6': 'settings',
};

interface Latest {
  run: Run;
  findings: Finding[];
  evidence: EvidenceVector;
}

export interface NextStep {
  key: string;
  text: string;
  color?: string;
}

/** What to do next, from what the dashboard knows, each with the key of the screen to do it on. */
export function nextSteps({
  config,
  latest,
  proposed,
  doctor,
}: {
  config: ConfigFile['kind'] | undefined;
  latest: Latest | null | undefined;
  proposed: number;
  doctor: DoctorReport | undefined;
}): NextStep[] {
  const steps: NextStep[] = [];

  if (config === 'none') steps.push({ key: 'y', text: 'Create the configuration (answer below)' });
  if (latest === null) steps.push({ key: '4', text: 'No run yet: start one on Run' });
  if (latest) {
    const n = latest.findings.length;

    if (n > 0) steps.push({ key: '2', text: `Read ${n} finding${n === 1 ? '' : 's'} of the latest run` });
    if (latest.run.verdict !== 'pass' && latest.run.policyReasons.length > 0 && n === 0)
      steps.push({ key: '2', text: 'See why the latest run did not pass' });
  }
  if (proposed > 0)
    steps.push({
      key: '3',
      text: `Review ${proposed} proposed specification${proposed === 1 ? '' : 's'}`,
    });
  if (
    latest &&
    count(latest.evidence.tests, 'weak_or_incomplete') +
      count(latest.evidence.tests, 'tautological_or_disconnected') >
      0
  )
    steps.push({ key: '5', text: 'Plan stronger tests on Improve tests' });
  if (doctor?.features.some((f) => f.state !== 'enabled'))
    steps.push({ key: '-', text: 'Some features are limited: see Tools', color: 'yellow' });
  if (latest && steps.length === 0)
    steps.push({ key: '4', text: 'Nothing waiting. Run again after a change' });

  return steps;
}

function count(counts: [string, number][] | null, status: string): number {
  return counts?.find(([s]) => s === status)?.[1] ?? 0;
}

export function Home({
  api,
  active,
  onBack,
  onChange,
  version,
  height,
  width,
  navigate,
  setHints,
}: ScreenProps) {
  const config = useLoad(() => api.readConfig(), [version]);
  const doctor = useLoad(() => api.doctor(), [version]);
  const latest = useLoad((): Latest | null => {
    const id = api.runs()[0];

    return id
      ? { run: api.readRun(id), findings: api.readFindings(id), evidence: api.readEvidence(id) }
      : null;
  }, [version]);
  const proposed = useLoad(() => api.properties().filter((p) => p.status === 'proposed').length, [version]);
  const [initError, setInitError] = useState<unknown>(null);
  const [initialized, setInitialized] = useState<string[] | null>(null);
  const uninitialized = config.data?.kind === 'none';

  useEffect(() => {
    if (active)
      setHints([
        ['↑↓', 'scroll'],
        ['2-6', 'open a screen'],
        ...(uninitialized ? ([['y/n', 'create config']] as [string, string][]) : []),
        ['Esc', 'back'],
      ]);
  }, [active, uninitialized, setHints]);

  useInput(
    (input, key) => {
      const target = SHORTCUT[input];

      if (target) navigate(target);
      else if (key.escape && !uninitialized) onBack();
    },
    { isActive: active },
  );

  const wide = width >= TWO_COLUMNS;
  const steps = nextSteps({
    config: config.data?.kind,
    latest: latest.loading ? undefined : latest.error ? undefined : latest.data,
    proposed: proposed.data ?? 0,
    doctor: doctor.data,
  });

  const project = (
    <Card title="Project" right={<Text color="cyan">{path.basename(api.root) || api.root}</Text>}>
      <Row label="path">
        {/* A long path keeps its end, the part that names the project, instead of wrapping. */}
        <Text wrap="truncate-start">{abbreviateHome(api.root)}</Text>
      </Row>
      <Row label="packages">{packageManager(config.data, doctor.data)}</Row>
      <Row label="config">
        {config.error ? (
          <Text color="red">unreadable</Text>
        ) : config.data?.kind === 'json' ? (
          <Text>{projectPath(api.root, config.data.file)}</Text>
        ) : config.data?.kind === 'code' ? (
          <Text>
            {projectPath(api.root, config.data.file)}
            <Text dimColor> (code, read-only here)</Text>
          </Text>
        ) : config.data?.kind === 'none' ? (
          <Text color="yellow">none yet</Text>
        ) : (
          <Text dimColor>loading</Text>
        )}
      </Row>
    </Card>
  );

  const run = <LatestRun latest={latest} />;

  const next = (
    <Card title="Next steps">
      {steps.length === 0 ? <Text dimColor>loading</Text> : null}
      {steps.map((s) => (
        <Box key={s.text}>
          <Box flexShrink={0} marginRight={1}>
            {s.key === '-' ? <Text>{'   '}</Text> : <Text inverse>{` ${s.key} `}</Text>}
          </Box>
          <Text wrap="truncate-end" {...(s.color ? { color: s.color } : {})}>
            {s.text}
          </Text>
        </Box>
      ))}
    </Card>
  );

  const tools = <Tools doctor={doctor} width={wide ? Math.floor(width * 0.45) - 4 : width - 4} />;

  const init = uninitialized ? (
    <Card title="Get started" color="yellow">
      <Text>This project has no Veritas configuration yet.</Text>
      {initError ? <ErrorView error={initError} /> : null}
      <Confirm
        question="Create .veritas/config.json with the detected settings?"
        active={active}
        onYes={() => {
          try {
            const result = api.init();
            // The questions of the command line are not asked here: say which runner was chosen and why.
            setInitialized([
              `test runner: ${result.testRunner.name} (${result.testRunner.reason})`,
              ...result.nextSteps,
            ]);
            onChange();
          } catch (error) {
            setInitError(error);
          }
        }}
        onNo={onBack}
      />
    </Card>
  ) : null;
  const created = initialized ? (
    <Card title="Configuration created" color="green">
      <Text color="green">Created the configuration. Next steps:</Text>
      {initialized.map((s) => (
        <Text key={s} wrap="truncate-end">
          {' '}
          {s}
        </Text>
      ))}
    </Card>
  ) : null;

  return (
    <ScrollView active={active} height={height}>
      {config.error ? <ErrorView error={config.error} /> : null}
      {init}
      {created}
      {wide ? (
        <Box>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} marginRight={1}>
            {project}
            {run}
          </Box>
          <Box flexDirection="column" width="45%" flexShrink={0}>
            {next}
            {tools}
          </Box>
        </Box>
      ) : (
        <>
          {project}
          {run}
          {next}
          {tools}
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Box flexShrink={0} width={11}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} overflow="hidden" height={1}>
        {children}
      </Box>
    </Box>
  );
}

function packageManager(config: ConfigFile | undefined, doctor: DoctorReport | undefined): ReactNode {
  const cap = doctor?.capabilities.find((c) => c.name === 'package_manager');
  const configured =
    config?.kind === 'json'
      ? (config.raw as { project?: { packageManager?: unknown } } | null)?.project?.packageManager
      : undefined;
  const name = typeof configured === 'string' ? configured : undefined;

  if (!name && !cap) return <Text dimColor>checking</Text>;

  return (
    <Text>
      {name ?? cap?.detail}
      {cap?.version && cap.version !== name ? <Text dimColor> {cap.version}</Text> : null}
    </Text>
  );
}

/** Counts of one kind of evidence, each in the color of what it means; unknown statuses are yellow, never green. */
export function EvidenceRow({ label, counts }: { label: string; counts: [string, number][] | null }) {
  if (counts === null) return null;

  return (
    <Box>
      <Box flexShrink={0} width={11}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexWrap="wrap" flexGrow={1}>
        {counts.length === 0 ? <Text dimColor>none recorded</Text> : null}
        {counts.map(([status, count]) => (
          <Box key={status} marginRight={2} flexShrink={0}>
            <Text>
              <Text bold color={statusColor(status)}>
                {count}
              </Text>{' '}
              {status}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** The evidence vector of a run: one row per kind it recorded. */
export function Evidence({ evidence }: { evidence: EvidenceVector }) {
  const none = !evidence.tests && !evidence.mutants && !evidence.pbt && !evidence.claims;

  return (
    <Box flexDirection="column">
      <EvidenceRow label="tests" counts={evidence.tests} />
      <EvidenceRow label="mutants" counts={evidence.mutants} />
      <EvidenceRow label="pbt" counts={evidence.pbt} />
      <EvidenceRow label="claims" counts={evidence.claims} />
      {none ? <Text dimColor>no test, mutant or solver evidence recorded</Text> : null}
    </Box>
  );
}

export function FindingCounts({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return <Text dimColor>no findings</Text>;

  return (
    <Text wrap="truncate-end">
      {findings.length} finding{findings.length === 1 ? '' : 's'}:
      {SEVERITIES.map((s) => {
        const count = findings.filter((f) => f.severity === s).length;

        return count ? (
          <Text key={s}>
            {'  '}
            <Text bold color={severityColor(s)}>
              {count} {s}
            </Text>
          </Text>
        ) : null;
      })}
    </Text>
  );
}

function LatestRun({ latest }: { latest: ReturnType<typeof useLoad<Latest | null>> }) {
  if (latest.error)
    return (
      <Card title="Latest run">
        <ErrorView error={latest.error} />
      </Card>
    );
  if (latest.loading) return <Card title="Latest run">{<Text dimColor>loading</Text>}</Card>;
  if (!latest.data)
    return (
      <Card title="Latest run">
        <Text>No run yet.</Text>
      </Card>
    );
  const { run, findings, evidence } = latest.data;
  const took = runDuration(run);

  return (
    <Card
      title="Latest run"
      right={<Badge color={verdictColor(run.verdict)}>{run.verdict ?? run.status}</Badge>}
    >
      <Text wrap="truncate-end">
        <Text>{run.profile ?? run.command}</Text>
        <Text dimColor>
          {'  '}
          {ago(run.startedAt)}
          {took !== null ? `  took ${duration(took)}` : ''}
          {`  exit ${run.exitCode ?? '-'}`}
        </Text>
      </Text>
      {run.partial ? (
        <Text color="yellow">Partial: some stages did not finish, so the evidence is incomplete.</Text>
      ) : null}
      <StageStrip stages={run.stages} />
      <FindingCounts findings={findings} />
      <Evidence evidence={evidence} />
    </Card>
  );
}

const FEATURE_MARK = {
  enabled: { mark: '✔', color: 'green' },
  degraded: { mark: '!', color: 'yellow' },
  disabled: { mark: '✖', color: 'red' },
} as const;

function Tools({ doctor, width }: { doctor: ReturnType<typeof useLoad<DoctorReport>>; width: number }) {
  const features = doctor.data?.features ?? [];
  const cell = Math.max(...features.map((f) => f.feature.length), 6) + 4;
  const columns = Math.max(1, Math.floor(width / cell));
  // Each missing tool once, with the features it turns off and those it limits.
  const missing = new Map<string, { disabled: string[]; degraded: string[] }>();

  for (const f of features)
    for (const name of f.missing) {
      const entry = missing.get(name) ?? { disabled: [], degraded: [] };

      (f.state === 'disabled' ? entry.disabled : entry.degraded).push(f.feature);
      missing.set(name, entry);
    }
  const counts = (['enabled', 'degraded', 'disabled'] as const).map(
    (state) => [state, features.filter((f) => f.state === state).length] as const,
  );

  return (
    <Card
      title="Tools"
      right={
        features.length ? (
          <Text>
            {counts
              .filter(([, c]) => c > 0)
              .map(([state, c]) => (
                <Text key={state} color={FEATURE_MARK[state].color}>
                  {c} {state}{' '}
                </Text>
              ))}
          </Text>
        ) : null
      }
    >
      {doctor.loading ? <Text dimColor>checking</Text> : null}
      {doctor.error ? <ErrorView error={doctor.error} /> : null}
      <Box flexWrap="wrap" width={columns * cell}>
        {features.map((f) => (
          <Box key={f.feature} width={cell} flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color={FEATURE_MARK[f.state].color}>{FEATURE_MARK[f.state].mark}</Text> {f.feature}
            </Text>
          </Box>
        ))}
      </Box>
      {[...missing].map(([name, entry]) => (
        <Text key={name} wrap="truncate-end">
          <Text color={entry.disabled.length ? 'red' : 'yellow'}>no {name}</Text>
          <Text dimColor>
            {' '}
            {[
              entry.disabled.length ? `turns off ${entry.disabled.join(', ')}` : '',
              entry.degraded.length ? `limits ${entry.degraded.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('; ')}
          </Text>
        </Text>
      ))}
    </Card>
  );
}

/** The path with the home directory written as `~`, as a shell prompt shows it. */
export function abbreviateHome(file: string, home = homedir()): string {
  if (!home || home === path.sep) return file;
  if (file === home) return '~';

  const rest = file.slice(home.length);

  // Either separator follows the home directory: `/` everywhere, `\` on Windows too.
  return file.startsWith(home) && (rest.startsWith('/') || rest.startsWith(path.sep)) ? `~${rest}` : file;
}
