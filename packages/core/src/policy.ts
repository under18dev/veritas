import type { VeritasConfig } from './config/schema.js';
import { ExitCode } from './exit-codes.js';
import {
  exitCodeOfVerdict,
  isInconclusiveClaim,
  isInconclusiveStage,
  isToolFailureStage,
  POLICY_RULE,
  type PolicyVerdict,
  policyRule,
  verdictName,
  verdictOfRule,
} from './policy-decision.js';
import type { Finding } from './schema/finding.js';
import type { FormalClaim } from './schema/formal.js';
import type { Mutant } from './schema/mutation.js';
import type { Property } from './schema/property.js';
import type { StageResult } from './schema/run.js';
import type { TestAssessment } from './schema/tests.js';

export type { PolicyVerdict } from './policy-decision.js';

export interface PolicyDecision {
  exitCode: ExitCode;
  verdict: PolicyVerdict;
  reasons: string[];
}

/** Results the optional thresholds (`maxNewSurvivors`, `minPropertyCoverage`) are measured on. */
export interface PolicyEvidence {
  mutants?: Mutant[];
  properties?: Property[];
  assessments?: TestAssessment[];
}

/**
 * Optional CI thresholds. `maxNewSurvivors` counts surviving mutants in this run's scope (only the change with
 * `--since`). `minPropertyCoverage` is the share of accepted properties with at least one test assessed
 * `meaningful_with_evidence`. A threshold that cannot be measured is inconclusive, never passed.
 */
function checkThresholds(
  policy: VeritasConfig['policy'],
  stages: StageResult[],
  evidence: PolicyEvidence,
): { failures: string[]; undecided: string[] } {
  const failures: string[] = [];
  const undecided: string[] = [];

  if (policy.maxNewSurvivors !== undefined) {
    const mutate = stages.find((s) => s.stage === 'mutate');

    if (!mutate || (mutate.status !== 'succeeded' && mutate.status !== 'partial')) {
      undecided.push('policy.maxNewSurvivors: no mutation results in this run');
    } else {
      const survivors = (evidence.mutants ?? []).filter((m) => m.status === 'survived').length;

      if (survivors > policy.maxNewSurvivors)
        failures.push(
          `${survivors} surviving mutant(s), more than policy.maxNewSurvivors ${policy.maxNewSurvivors}`,
        );
    }
  }

  if (policy.minPropertyCoverage !== undefined) {
    const accepted = (evidence.properties ?? []).filter((p) => p.status === 'accepted');

    if (accepted.length === 0 || evidence.assessments === undefined) {
      undecided.push('policy.minPropertyCoverage: no accepted property or no test assessment in this run');
    } else {
      const covered = accepted.filter((p) =>
        (evidence.assessments ?? []).some(
          (a) => a.outcome === 'meaningful_with_evidence' && a.propertyIds.includes(p.id),
        ),
      ).length;
      const share = covered / accepted.length;

      if (share < policy.minPropertyCoverage)
        failures.push(
          `${covered} of ${accepted.length} accepted properties have a meaningful test, below policy.minPropertyCoverage ${policy.minPropertyCoverage}`,
        );
    }
  }

  return { failures, undecided };
}

/** The `ExitCode` for a code returned by the decision kernel. */
function exitCodeFrom(code: number): ExitCode {
  const known = Object.values(ExitCode).find((c) => c === code);

  if (known === undefined) throw new Error(`policy decision returned an unknown exit code ${code}`);

  return known;
}

/**
 * Map findings, claims and stage results to an exit code.
 * - Only confirmed findings can fail the policy; suspected findings never do.
 * - Stage errors are tool errors.
 * - Inconclusive results follow `inconclusiveBehavior`. With `warn` or `ignore` the exit code is 0 but the
 *   verdict stays `pass_with_warnings` and the reasons list every inconclusive item; it is never reported as `pass`.
 *
 * The decision itself is made by `policyRule` in `policy-decision.ts` on the counts gathered here; this function
 * only counts and writes the reasons.
 */
export function evaluatePolicy(
  policy: VeritasConfig['policy'],
  findings: Finding[],
  stages: StageResult[],
  claims: FormalClaim[] = [],
  evidence: PolicyEvidence = {},
): PolicyDecision {
  const confirmedViolations = findings.filter(
    (f) =>
      f.certainty === 'confirmed' &&
      (f.kind === 'spec_implementation_mismatch' ||
        f.kind === 'counterexample' ||
        f.kind === 'spec_violation_candidate'),
  );
  const toolErrors = stages.filter((s) => isToolFailureStage(s.status));
  const inconclusiveStages = stages.filter((s) => isInconclusiveStage(s.status));
  const inconclusiveClaims = claims.filter((c) => isInconclusiveClaim(c.status));
  const thresholds = checkThresholds(policy, stages, evidence);
  const open = findings.filter((f) => f.certainty !== 'informational' && !confirmedViolations.includes(f));

  const rule = policyRule({
    confirmedViolations: confirmedViolations.length,
    failOnConfirmedViolation: policy.confirmedViolation === 'fail',
    toolErrors: toolErrors.length,
    inconclusiveStages: inconclusiveStages.length,
    inconclusiveClaims: inconclusiveClaims.length,
    thresholdFailures: thresholds.failures.length,
    thresholdUndecided: thresholds.undecided.length,
    openFindings: open.length,
    failOnInconclusive: policy.inconclusiveBehavior === 'fail',
  });
  const verdictCode = verdictOfRule(rule);
  const verdict = verdictName(verdictCode);
  const exitCode = exitCodeFrom(exitCodeOfVerdict(verdictCode));

  const inconclusive = [
    ...inconclusiveStages.map((s) => `stage ${s.stage}=${s.status}`),
    ...inconclusiveClaims.map((c) => `claim ${c.id}=${c.status}`),
    ...thresholds.undecided,
  ];
  const violationReason = `${confirmedViolations.length} confirmed specification violation(s)`;
  const failOnConfirmed = confirmedViolations.length > 0 && policy.confirmedViolation === 'fail';

  if (rule === POLICY_RULE.thresholdFailure) {
    return {
      exitCode,
      verdict,
      reasons: [...(failOnConfirmed ? [violationReason] : []), ...thresholds.failures, ...inconclusive],
    };
  }

  if (rule === POLICY_RULE.confirmedViolation)
    return { exitCode, verdict, reasons: [violationReason, ...inconclusive] };

  if (rule === POLICY_RULE.toolError) {
    const failed = `stage failure(s): ${toolErrors.map((s) => `${s.stage}=${s.status}`).join(', ')}`;

    return { exitCode, verdict, reasons: [failed, ...inconclusive] };
  }

  if (rule === POLICY_RULE.inconclusive) return { exitCode, verdict, reasons: inconclusive };

  const reasons: string[] = [];

  if (confirmedViolations.length > 0) reasons.push('confirmed violations reported as warnings by policy');

  if (open.length > 0) reasons.push(`${open.length} finding(s) to review (not policy failures)`);

  reasons.push(...inconclusive.map((r) => `inconclusive (${policy.inconclusiveBehavior}): ${r}`));

  return { exitCode, verdict, reasons };
}
