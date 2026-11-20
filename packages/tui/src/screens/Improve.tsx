import type { PatchAttempt } from '@under18dev/veritas-core';
import type { PlanResult } from '@under18dev/veritas-improvement';
import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { Confirm, ErrorView, numbered, Pager, SelectList, Title } from '../components.js';
import type { ScreenProps } from '../screen.js';

export function planLines(result: PlanResult): string[] {
  const lines = [`plan ${result.planId} from run ${result.runId}: ${result.outcome}`];
  const plan = result.plan;

  if (plan) {
    lines.push('', `goal: ${plan.goal}`, '', 'proposed tests (expected values from the specification):');
    for (const t of plan.proposedTestCases) lines.push(`  ${t.file}: ${t.name}`, `      ${t.rationale}`);
    if (plan.risks.length) lines.push('', 'risks:', ...plan.risks.map((r) => `  - ${r}`));
    lines.push('', 'patch:', ...plan.patchPreview.split('\n'));
  }
  if (result.specViolationCandidates.length)
    lines.push(
      '',
      `${result.specViolationCandidates.length} possible specification violation(s): a decision is needed`,
    );
  if (result.skipped.length)
    lines.push('', 'skipped:', ...result.skipped.map((s) => `  ${s.propertyId}: ${s.reason}`));
  if (result.reasons.length) lines.push('', ...result.reasons);
  lines.push('', `plan file: ${result.planFile} (no project file was written)`);

  return lines;
}

export function attemptLines(a: PatchAttempt): string[] {
  return [
    `attempt ${a.id}: ${a.outcome}${a.rolledBack ? ' (rolled back)' : ''}`,
    ...(a.before
      ? [`before: tests ${a.before.testsPassed} passed, mutants ${a.before.mutantsKilled} killed`]
      : []),
    ...(a.after
      ? [`after:  tests ${a.after.testsPassed} passed, mutants ${a.after.mutantsKilled} killed`]
      : []),
    ...a.reasons,
  ];
}

type State =
  | { kind: 'start' }
  | { kind: 'planning' }
  | { kind: 'plan'; result: PlanResult }
  | { kind: 'confirm'; result: PlanResult }
  | { kind: 'applying'; result: PlanResult }
  | { kind: 'applied'; attempt: PatchAttempt }
  | { kind: 'failed'; error: unknown };

export function Improve({ api, active, onBack, onChange, height }: ScreenProps) {
  const [state, setState] = useState<State>({ kind: 'start' });
  const [includeProposed, setIncludeProposed] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (state.kind === 'planning' || state.kind === 'applying') controller.current?.abort();
        else if (state.kind === 'start') onBack();
        else setState({ kind: 'start' });
      } else if (state.kind === 'plan' && input === 'a' && state.result.approvalToken)
        setState({ kind: 'confirm', result: state.result });
    },
    { isActive: active && state.kind !== 'confirm' },
  );

  const track = <T,>(work: (signal: AbortSignal) => Promise<T>, done: (value: T) => State) => {
    const c = new AbortController();
    controller.current = c;
    work(c.signal)
      .then(
        (value) => setState(done(value)),
        (error: unknown) => setState({ kind: 'failed', error }),
      )
      .finally(() => {
        controller.current = null;
        onChange();
      });
  };

  return (
    <Box flexDirection="column">
      <Title>Improve tests</Title>
      {state.kind === 'start' ? (
        <>
          <Text dimColor>
            Proposes tests whose expected values come from accepted specifications. Creating a plan writes no
            project file.
          </Text>
          <SelectList
            active={active}
            items={[
              { label: 'Create a plan', value: 'plan' },
              {
                label: `Also use proposed specifications: ${includeProposed ? 'yes' : 'no'}`,
                value: 'proposed',
                hint: 'only accepted ones by default',
              },
            ]}
            onSelect={(item) => {
              if (item.value === 'proposed') setIncludeProposed((v) => !v);
              else {
                setState({ kind: 'planning' });
                track(
                  (signal) => api.plan(includeProposed, signal),
                  (result) => ({ kind: 'plan', result }),
                );
              }
            }}
          />
        </>
      ) : null}
      {state.kind === 'planning' ? <Text dimColor>Planning… Esc cancels.</Text> : null}
      {state.kind === 'plan' || state.kind === 'confirm' ? (
        <>
          <Pager
            active={active && state.kind === 'plan'}
            height={height - 4}
            lines={planLines(state.result)}
          />
          {state.kind === 'plan' ? (
            <Text dimColor>
              {state.result.approvalToken ? 'a apply this plan · Esc back' : 'Nothing to apply. Esc back'}
            </Text>
          ) : (
            <Confirm
              active={active}
              question={`Apply plan ${state.result.planId}? The tests run in an isolated copy, and only the new test files are written if every check passes.`}
              onNo={() => setState({ kind: 'plan', result: state.result })}
              onYes={() => {
                const { result } = state;
                setState({ kind: 'applying', result });
                track(
                  (signal) => api.apply(result.planId, result.approvalToken ?? '', signal),
                  (attempt) => ({ kind: 'applied', attempt }),
                );
              }}
            />
          )}
        </>
      ) : null}
      {state.kind === 'applying' ? <Text dimColor>Applying in an isolated copy… Esc cancels.</Text> : null}
      {state.kind === 'applied' ? (
        <>
          {numbered(attemptLines(state.attempt)).map((line) => (
            <Text key={line.key} {...(line.n === 0 ? { bold: true } : {})}>
              {line.text}
            </Text>
          ))}
          <Text dimColor>Esc back</Text>
        </>
      ) : null}
      {state.kind === 'failed' ? (
        <>
          <ErrorView error={state.error} />
          <Text dimColor>Esc back</Text>
        </>
      ) : null}
    </Box>
  );
}
