import { type Finding, isPlainRelativePath, type Location, type Run } from '@under18dev/veritas-core';
import type { Explanation } from '@under18dev/veritas-engine';
import { Box, type DOMElement, Text, useBoxMetrics, useInput } from 'ink';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ago,
  Badge,
  Card,
  countBy,
  duration,
  ErrorView,
  errorText,
  runDuration,
  ScrollView,
  SEVERITIES,
  SelectList,
  SeverityLabel,
  StageStrip,
  statusColor,
  useLoad,
  verdictColor,
} from '../components.js';
import type { ScreenProps } from '../screen.js';
import { Evidence, FindingCounts } from './Home.js';

type View =
  | { kind: 'runs' }
  | { kind: 'run'; runId: string }
  | { kind: 'finding'; runId: string; finding: Finding };

/** The longest verdict, so that the badges of the run list line up. */
const VERDICT_WIDTH = 'pass_with_warnings'.length;

export function Results({ api, active, onBack, height, width, version, setHints }: ScreenProps) {
  const [view, setView] = useState<View>({ kind: 'runs' });
  const runs = useLoad(
    () =>
      api.runs().map((id) => ({
        id,
        run: safe(() => api.readRun(id)),
        findings: safe(() => api.readFindings(id).length),
      })),
    [version],
  );

  useEffect(() => {
    if (!active) return;
    setHints(
      view.kind === 'finding'
        ? [
            ['↑↓', 'scroll'],
            ['Esc', 'back to the run'],
          ]
        : view.kind === 'run'
          ? [
              ['↑↓', 'move'],
              ['Enter', 'open finding'],
              ['e', 'evidence counts'],
              ['Esc', 'back to runs'],
            ]
          : [
              ['↑↓', 'move'],
              ['Enter', 'open run'],
              ['Esc', 'back'],
            ],
    );
  }, [active, view.kind, setHints]);

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
  if (view.kind === 'finding')
    return <FindingDetail {...{ api, active, height }} runId={view.runId} finding={view.finding} />;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Runs</Text>
        <Text dimColor> newest first</Text>
      </Box>
      {runs.error ? <ErrorView error={runs.error} /> : null}
      {runs.data?.length === 0 ? <Text>No run yet. Start one from Run (press Esc, then 4).</Text> : null}
      <SelectList
        active={active}
        height={height - 3}
        items={(runs.data ?? []).map((r) => ({ label: r.id, value: r }))}
        render={({ value: { id, run, findings } }, selected) =>
          run ? (
            <>
              <Box flexShrink={0} marginRight={1}>
                <Badge color={verdictColor(run.verdict)}>
                  {(run.verdict ?? run.status).padEnd(VERDICT_WIDTH)}
                </Badge>
              </Box>
              {/* Before the fields a narrow terminal cuts: a partial run must never look complete. */}
              {run.partial ? (
                <Box flexShrink={0} marginRight={1}>
                  <Badge color="yellow">partial</Badge>
                </Box>
              ) : null}
              <Text wrap="truncate-end" {...(selected ? { color: 'cyan' } : {})}>
                {(findings === null
                  ? '? findings'
                  : `${findings} finding${findings === 1 ? '' : 's'}`
                ).padEnd(12)}
                {(run.profile ?? run.command).padEnd(9)}
                {/* The duration is the first to go in a narrow terminal. */}
                {width >= 62 ? ago(run.startedAt).padEnd(9) : ago(run.startedAt)}
                {width >= 62 ? <Text dimColor>{tookText(run)}</Text> : null}
              </Text>
            </>
          ) : (
            <Text color="red" wrap="truncate-end">
              {id} (unreadable)
            </Text>
          )
        }
        onSelect={(item) => setView({ kind: 'run', runId: item.value.id })}
      />
    </Box>
  );
}

function tookText(run: Run): string {
  const took = runDuration(run);

  return took === null ? '-' : duration(took);
}

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

const SEVERITY_RANK = new Map<string, number>(SEVERITIES.map((s, i) => [s, i]));
const CERTAINTY_RANK = new Map([
  ['confirmed', 0],
  ['suspected', 1],
  ['informational', 2],
]);

/** Most severe first; confirmed before suspected within a severity. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (SEVERITY_RANK.get(a.severity) ?? 9) - (SEVERITY_RANK.get(b.severity) ?? 9) ||
      (CERTAINTY_RANK.get(a.certainty) ?? 9) - (CERTAINTY_RANK.get(b.certainty) ?? 9),
  );
}

function Certainty({ certainty }: { certainty: string }) {
  return (
    <Text {...(certainty === 'confirmed' ? { bold: true } : { dimColor: true })}>
      {`${certainty} `.padEnd(10)}
    </Text>
  );
}

/** The run's verdict, timing and policy reasons in one card. */
export function RunHeader({ run }: { run: Run }) {
  const took = runDuration(run);

  return (
    <Card title="Run" right={<Badge color={verdictColor(run.verdict)}>{run.verdict ?? run.status}</Badge>}>
      <Text wrap="truncate-end">
        {run.command} {run.profile ?? ''}
        <Text dimColor>
          {'  '}
          {ago(run.startedAt)}
          {took !== null ? `  took ${duration(took)}` : ''}
        </Text>
        {'  '}exit {run.exitCode ?? '-'}
      </Text>
      <Text dimColor wrap="truncate-end">
        {run.id}
      </Text>
      {run.partial ? (
        <Text color="yellow">Partial: some stages did not finish, so the evidence is incomplete.</Text>
      ) : null}
      {run.policyReasons.map((r) => (
        <Text key={r} color="yellow" wrap="truncate-end">
          {r}
        </Text>
      ))}
    </Card>
  );
}

function RunDetail({
  api,
  active,
  height,
  runId,
  onOpen,
}: Pick<ScreenProps, 'api' | 'active' | 'height'> & { runId: string; onOpen: (f: Finding) => void }) {
  const data = useLoad(
    () => ({
      run: api.readRun(runId),
      findings: sortFindings(api.readFindings(runId)),
      evidence: safe(() => api.readEvidence(runId)),
    }),
    [runId],
  );
  const listBox = useRef<DOMElement>(null);
  const listRows = useBoxMetrics(listBox).height;
  const [showEvidence, setShowEvidence] = useState(false);
  // Kept while the evidence counts replace the list, so `e` twice returns to the same finding.
  const [cursor, setCursor] = useState(0);
  const onHighlight = useCallback((_item: unknown, index: number) => setCursor(index), []);

  useInput(
    (input) => {
      if (input === 'e') setShowEvidence((v) => !v);
    },
    { isActive: active },
  );

  if (data.error) return <ErrorView error={data.error} />;
  if (!data.data) return <Text dimColor>loading…</Text>;
  const { run, findings, evidence } = data.data;
  const kinds = countBy(findings, (f) => f.kind);

  return (
    <Box flexDirection="column" height={height}>
      <RunHeader run={run} />
      <StageStrip stages={run.stages} timings />
      {showEvidence ? null : (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <FindingCounts findings={findings} />
          <Box flexWrap="wrap">
            {kinds.map(([kind, n]) => (
              <Box key={kind} marginRight={2} flexShrink={0}>
                <Text dimColor>
                  {n} {kind}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
      <Box ref={listBox} flexGrow={1} flexShrink={1} minHeight={1} flexDirection="column" overflow="hidden">
        {showEvidence ? (
          // A deep run leaves few rows here; the counts scroll instead of being cut.
          <ScrollView active={active} height={Math.max(1, listRows)}>
            <Card title="Evidence" right={<Text dimColor>counts per status; e shows the findings</Text>}>
              {evidence ? <Evidence evidence={evidence} /> : <Text color="yellow">unreadable</Text>}
            </Card>
          </ScrollView>
        ) : findings.length ? (
          <SelectList
            active={active}
            height={Math.max(1, listRows - 1)}
            initial={cursor}
            onHighlight={onHighlight}
            items={findings.map((f) => ({ label: f.title, value: f }))}
            render={({ value: f }, selected) => (
              <>
                <Box flexShrink={0}>
                  <SeverityLabel severity={f.severity} />
                  <Certainty certainty={f.certainty} />
                </Box>
                <Text wrap="truncate-end" {...(selected ? { color: 'cyan' } : {})}>
                  {f.title}
                </Text>
              </>
            )}
            onSelect={(item) => onOpen(item.value)}
          />
        ) : null}
      </Box>
    </Box>
  );
}

/** A heading that says whether what follows is recorded evidence or a suggestion. */
function Banner({ color, children }: { color: string; children: string }) {
  return (
    <Box marginTop={1}>
      <Badge color={color}>{children}</Badge>
    </Box>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold underline>
          {title}
        </Text>
        {count !== undefined ? <Text dimColor> ({count})</Text> : null}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

/** A status in the color of what it means; anything not known to be good is yellow. */
function Status({ children }: { children: string }) {
  return <Text color={statusColor(children)}>{children}</Text>;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Survivors first: they are what a mutant finding is about. */
const MUTANT_RANK: Record<string, number> = { survived: 0, suspected_equivalent: 1, killed: 9 };

function where(location: Location): string {
  return `${location.file}${location.range ? `:${location.range.start}` : ''}`;
}

/** The evidence of a finding in sections, followed by the suggested next actions, which are not evidence. */
export function FindingSections({
  finding: f,
  explanation,
  error,
}: {
  finding: Finding;
  explanation: Explanation | null;
  error: unknown;
}) {
  const e = explanation;
  const assessments = e?.assessments ?? [];

  return (
    <Box flexDirection="column">
      <Box>
        <SeverityLabel severity={f.severity} />
        <Certainty certainty={f.certainty} />
        <Text dimColor>{f.kind}</Text>
      </Box>
      <Text bold wrap="wrap">
        {f.title}
      </Text>
      <Text dimColor>{f.id}</Text>
      <Section title="Why it was reported">
        {f.explanation.map((line) => (
          <Text key={line} wrap="wrap">
            {line}
          </Text>
        ))}
      </Section>
      <Banner color="green">EVIDENCE recorded by the run</Banner>
      {error ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">The linked evidence could not be read, so only the IDs are shown:</Text>
          <Text dimColor wrap="wrap">
            {errorText(error).join(' ')}
          </Text>
        </Box>
      ) : null}
      {f.locations.length ? (
        <Section title="Locations" count={f.locations.length}>
          {f.locations.map((l) => (
            <Text key={where(l)} wrap="truncate-end">
              {where(l)}
            </Text>
          ))}
        </Section>
      ) : null}
      {e && (e.sources.length || e.statements.length) ? (
        <Section title="Sources" count={e.sources.length}>
          {e.sources.map((s) => (
            <Box key={s.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text dimColor>{s.kind}</Text> {s.locator}
                {s.range ? `:${s.range.start}` : ''}
              </Text>
              <Text wrap="wrap" dimColor>
                {'  '}"{s.summary.slice(0, 200)}"
              </Text>
            </Box>
          ))}
          {e.statements.map((st) => (
            <Text key={`${st.range.start}-${st.quote}`} wrap="wrap">
              <Text dimColor>line {st.range.start}: </Text>"{st.quote}"
            </Text>
          ))}
        </Section>
      ) : null}
      {e?.properties.length ? (
        <Section title="Properties" count={e.properties.length}>
          {e.properties.map((p) => (
            <Text key={p.id} wrap="wrap">
              {p.id}{' '}
              <Text dimColor>
                [{p.status}, {p.origin}]
              </Text>{' '}
              {p.description}
            </Text>
          ))}
        </Section>
      ) : !e && f.propertyIds.length ? (
        <Section title="Properties" count={f.propertyIds.length}>
          <Text wrap="wrap">{f.propertyIds.join(', ')}</Text>
        </Section>
      ) : null}
      {e && (e.tests.length || assessments.length) ? (
        <Section title="Tests" count={e.tests.length}>
          {e.tests.map((t) => (
            <Text key={t.id} wrap="truncate-end">
              {t.file}:{t.location.range?.start ?? '?'} <Text dimColor>"{t.name}"</Text>
            </Text>
          ))}
          {assessments.map((a) => (
            <Text key={`${a.testId}-${a.outcome}`} wrap="wrap">
              {a.testId}: <Status>{a.outcome}</Status>
              <Text dimColor> {a.rationale.join('; ')}</Text>
            </Text>
          ))}
        </Section>
      ) : !e && f.testIds.length ? (
        <Section title="Tests" count={f.testIds.length}>
          <Text wrap="wrap">{f.testIds.join(', ')}</Text>
        </Section>
      ) : null}
      {e?.mutants.length ? (
        <Section title="Mutants" count={e.mutants.length}>
          {[...e.mutants]
            .sort((a, b) => (MUTANT_RANK[a.status] ?? 5) - (MUTANT_RANK[b.status] ?? 5))
            .map((m) => (
              <Text key={m.id} wrap="wrap">
                {m.id} <Status>{m.status}</Status>{' '}
                <Text dimColor>
                  {where(m.location)} {oneLine(m.original)} {'->'} {oneLine(m.replacement)}
                </Text>
              </Text>
            ))}
        </Section>
      ) : !e && f.mutantIds.length ? (
        <Section title="Mutants" count={f.mutantIds.length}>
          <Text wrap="wrap">{f.mutantIds.join(', ')}</Text>
        </Section>
      ) : null}
      {e?.claims.length ? (
        <Section title="Solver claims" count={e.claims.length}>
          {e.claims.map((c) => (
            <Box key={c.id} flexDirection="column">
              <Text wrap="wrap">
                {c.id} <Status>{c.status}</Status>
                <Text dimColor>
                  {' '}
                  {c.kind}, {c.assurance}
                </Text>
                {c.counterexample ? <Text> counterexample {JSON.stringify(c.counterexample)}</Text> : null}
              </Text>
              {c.solverInputArtifact ? (
                <Text dimColor wrap="truncate-end">
                  {'  '}smt:{' '}
                  {isPlainRelativePath(c.solverInputArtifact)
                    ? `.veritas/runs/${e.runId}/${c.solverInputArtifact}`
                    : '(unsafe location omitted)'}
                </Text>
              ) : null}
            </Box>
          ))}
        </Section>
      ) : !e && f.claimIds.length ? (
        <Section title="Solver claims" count={f.claimIds.length}>
          <Text wrap="wrap">{f.claimIds.join(', ')}</Text>
        </Section>
      ) : null}
      <Banner color="magenta">SUGGESTED next actions, not verified</Banner>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {f.nextActions.length === 0 ? <Text dimColor>none</Text> : null}
        {f.nextActions.map((a) => (
          <Text key={a} wrap="wrap">
            {'> '}
            {a}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function FindingDetail({
  api,
  active,
  height,
  runId,
  finding,
}: Pick<ScreenProps, 'api' | 'active' | 'height'> & { runId: string; finding: Finding }) {
  const data = useLoad(() => {
    const explanation = api.explain(finding.id);

    // `explain` reads the latest run; for an older run, the finding it found may be a different one.
    if (explanation.runId !== runId) throw new Error(`the evidence is kept for the latest run, not ${runId}`);

    return explanation;
  }, [finding.id, runId]);

  if (data.loading) return <Text dimColor>loading…</Text>;

  return (
    <ScrollView active={active} height={height}>
      <FindingSections finding={finding} explanation={data.data ?? null} error={data.error ?? null} />
    </ScrollView>
  );
}
