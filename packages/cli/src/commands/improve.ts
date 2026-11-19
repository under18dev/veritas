import { ExitCode, type ImprovementOutcome, type PatchAttempt, VeritasError } from '@veritas/core';
import { applyImprovement, type PlanOutcome, type PlanResult, planImprovement } from '@veritas/improvement';
import { emitJson, emitText, type GlobalOptions } from '../output.js';

type Opts = GlobalOptions & Record<string, unknown>;

/**
 * Exit codes of `veritas improve`: 0 a plan is ready (dry run) or the improvement was applied; 4 no safe
 * improvement or a specification decision is needed; 1 the plan was blocked by the safety checks;
 * 3 tool error; 2 user error (bad or missing token, refusal in CI, stale plan).
 */
export function improveExitCode(outcome: PlanOutcome | ImprovementOutcome): ExitCode {
  switch (outcome) {
    case 'planned':
    case 'improved':
      return ExitCode.Success;
    case 'no_safe_improvement':
    case 'needs_spec_decision':
      return ExitCode.Inconclusive;
    case 'blocked':
      return ExitCode.PolicyFailure;
    case 'error':
      return ExitCode.ToolError;
  }
}

function parseIterations(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < 1 || n > 20) {
    throw new VeritasError('user', 'BUDGET_INVALID', '--max-iterations must be an integer from 1 to 20');
  }
  return n;
}

function planText(result: PlanResult): string {
  const lines = [`plan ${result.planId} from ${result.runId}: ${result.outcome}`];
  const plan = result.plan;
  if (plan) {
    lines.push('', `goal: ${plan.goal}`, '', 'proposed tests (expected values from the specification):');
    for (const t of plan.proposedTestCases) lines.push(`  ${t.file}: ${t.name}`, `      ${t.rationale}`);
    if (plan.observedGaps.length)
      lines.push('', 'gaps:', ...plan.observedGaps.map((g) => `  ${g.findingId}  ${g.description}`));
    if (plan.risks.length) lines.push('', 'risks:', ...plan.risks.map((r) => `  - ${r}`));
    lines.push(
      '',
      `budget: ${plan.budget.maxIterations} iteration(s), ${plan.budget.maxPatchFiles} file(s), ${plan.budget.timeBudgetMs} ms, ${plan.budget.maxTestRetries} test retr(y/ies)`,
      '',
      'patch preview:',
      plan.patchPreview,
    );
  }
  if (result.specViolationCandidates.length) {
    lines.push('', 'spec violation candidates (not added; expected values unchanged):');
    for (const c of result.specViolationCandidates) lines.push(`  ${c.id}  ${c.reason}`);
    lines.push(
      `  implementation fix proposals: .veritas/improvements/${result.planId}/implementation-fix-proposal.json`,
    );
  }
  if (result.reasons.length) lines.push('', ...result.reasons.map((r) => `note: ${r}`));
  if (result.skipped.length) {
    lines.push(
      '',
      'skipped:',
      ...result.skipped.map(
        (s) => `  ${s.propertyId ?? '-'} ${s.input ? JSON.stringify(s.input) : ''} ${s.reason}`,
      ),
    );
  }
  if (result.approvalToken) {
    lines.push(
      '',
      `approval token for plan ${result.planId}: ${result.approvalToken}`,
      `apply after review: veritas improve --apply --plan ${result.planId} --approve ${result.approvalToken}`,
    );
  }
  lines.push('', `plan: ${result.planFile} (no project file was written)`);
  return lines.join('\n');
}

function attemptText(attempt: PatchAttempt): string {
  const m = (s: PatchAttempt['before']) =>
    s
      ? `tests ${s.testsPassed} passed / ${s.testsFailed} failed, mutants ${s.mutantsKilled} killed / ${s.mutantsSurvived} survived`
      : 'not measured';
  return [
    `attempt ${attempt.id} for plan ${attempt.planId}: ${attempt.outcome}${attempt.rolledBack ? ' (rolled back)' : ''}`,
    `before: ${m(attempt.before)}`,
    `after:  ${m(attempt.after)}`,
    ...attempt.reasons.map((r) => `note: ${r}`),
  ].join('\n');
}

export async function improveCommand(opts: Opts): Promise<ExitCode> {
  if (opts.apply && opts.dryRun) {
    throw new VeritasError('user', 'IMPROVE_MODE', '--apply and --dry-run cannot be combined');
  }
  if (!opts.apply) {
    const result = await planImprovement({
      root: opts.root,
      ...(opts.run ? { runId: String(opts.run) } : {}),
      ...(opts.maxIterations !== undefined ? { maxIterations: parseIterations(opts.maxIterations) } : {}),
      allowCodeConfig: Boolean(opts.allowCodeConfig),
    });
    const exitCode = improveExitCode(result.outcome);
    if (opts.json) emitJson({ status: result.outcome, exitCode, ...result });
    else emitText(planText(result));
    return exitCode;
  }
  if (typeof opts.plan !== 'string' || opts.plan === '') {
    throw new VeritasError(
      'user',
      'PLAN_REQUIRED',
      '--apply needs --plan <id>',
      'run `veritas improve --dry-run` first',
    );
  }
  const attempt = await applyImprovement({
    root: opts.root,
    planId: opts.plan,
    approvalToken: typeof opts.approve === 'string' ? opts.approve : '',
    allowCodeConfig: Boolean(opts.allowCodeConfig),
  });
  const exitCode = improveExitCode(attempt.outcome);
  if (opts.json) emitJson({ status: attempt.outcome, exitCode, attempt });
  else emitText(attemptText(attempt));
  return exitCode;
}
