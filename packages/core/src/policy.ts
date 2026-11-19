import type { VeritasConfig } from './config/schema.js';
import { ExitCode } from './exit-codes.js';
import type { Finding } from './schema/finding.js';
import type { FormalClaim } from './schema/formal.js';
import type { Mutant } from './schema/mutation.js';
import type { Property } from './schema/property.js';
import type { StageResult } from './schema/run.js';
import type { StageStatus, VerificationStatus } from './schema/status.js';
import type { TestAssessment } from './schema/tests.js';

/** `pass` is only possible when every stage succeeded and nothing is inconclusive. */
export type PolicyVerdict = 'pass' | 'pass_with_warnings' | 'policy_failure' | 'tool_error' | 'inconclusive';

export interface PolicyDecision {
  exitCode: ExitCode;
  verdict: PolicyVerdict;
  reasons: string[];
}

const TOOL_FAILURE: StageStatus[] = ['error', 'failed'];
const INCONCLUSIVE_STAGE: StageStatus[] = ['partial', 'skipped', 'unsupported', 'timeout', 'cancelled'];
const INCONCLUSIVE_CLAIM: VerificationStatus[] = [
  'unknown',
  'timeout',
  'unsupported',
  'semantic_mismatch',
  'error',
];

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

/**
 * Map findings, claims and stage results to an exit code.
 * - Only confirmed findings can fail the policy; suspected findings never do.
 * - Stage errors are tool errors.
 * - Inconclusive results follow `inconclusiveBehavior`. With `warn` or `ignore` the exit code is 0 but the
 *   verdict stays `pass_with_warnings` and the reasons list every inconclusive item; it is never reported as `pass`.
 */
export function evaluatePolicy(
  policy: VeritasConfig['policy'],
  findings: Finding[],
  stages: StageResult[],
  claims: FormalClaim[] = [],
  evidence: PolicyEvidence = {},
): PolicyDecision {
  const reasons: string[] = [];
  const confirmedViolations = findings.filter(
    (f) =>
      f.certainty === 'confirmed' &&
      (f.kind === 'spec_implementation_mismatch' ||
        f.kind === 'counterexample' ||
        f.kind === 'spec_violation_candidate'),
  );
  const toolErrors = stages.filter((s) => TOOL_FAILURE.includes(s.status));
  const inconclusive = [
    ...stages.filter((s) => INCONCLUSIVE_STAGE.includes(s.status)).map((s) => `stage ${s.stage}=${s.status}`),
    ...claims.filter((c) => INCONCLUSIVE_CLAIM.includes(c.status)).map((c) => `claim ${c.id}=${c.status}`),
  ];

  const thresholds = checkThresholds(policy, stages, evidence);
  inconclusive.push(...thresholds.undecided);
  if (thresholds.failures.length > 0) {
    return {
      exitCode: ExitCode.PolicyFailure,
      verdict: 'policy_failure',
      reasons: [
        ...(confirmedViolations.length > 0 && policy.confirmedViolation === 'fail'
          ? [`${confirmedViolations.length} confirmed specification violation(s)`]
          : []),
        ...thresholds.failures,
        ...inconclusive,
      ],
    };
  }
  if (confirmedViolations.length > 0 && policy.confirmedViolation === 'fail') {
    reasons.push(`${confirmedViolations.length} confirmed specification violation(s)`);
    return {
      exitCode: ExitCode.PolicyFailure,
      verdict: 'policy_failure',
      reasons: [...reasons, ...inconclusive],
    };
  }
  if (toolErrors.length > 0) {
    reasons.push(`stage failure(s): ${toolErrors.map((s) => `${s.stage}=${s.status}`).join(', ')}`);
    return { exitCode: ExitCode.ToolError, verdict: 'tool_error', reasons: [...reasons, ...inconclusive] };
  }
  if (inconclusive.length > 0 && policy.inconclusiveBehavior === 'fail') {
    return { exitCode: ExitCode.Inconclusive, verdict: 'inconclusive', reasons: inconclusive };
  }
  if (confirmedViolations.length > 0) reasons.push('confirmed violations reported as warnings by policy');
  const open = findings.filter((f) => f.certainty !== 'informational' && !confirmedViolations.includes(f));
  if (open.length > 0) reasons.push(`${open.length} finding(s) to review (not policy failures)`);
  if (inconclusive.length > 0)
    reasons.push(...inconclusive.map((r) => `inconclusive (${policy.inconclusiveBehavior}): ${r}`));
  return {
    exitCode: ExitCode.Success,
    verdict: reasons.length > 0 ? 'pass_with_warnings' : 'pass',
    reasons,
  };
}
