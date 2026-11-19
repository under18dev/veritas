import type { VeritasConfig } from './config/schema.js';
import { ExitCode } from './exit-codes.js';
import type { Finding } from './schema/finding.js';
import type { FormalClaim } from './schema/formal.js';
import type { StageResult } from './schema/run.js';
import type { StageStatus, VerificationStatus } from './schema/status.js';

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
  if (inconclusive.length > 0)
    reasons.push(...inconclusive.map((r) => `inconclusive (${policy.inconclusiveBehavior}): ${r}`));
  return {
    exitCode: ExitCode.Success,
    verdict: reasons.length > 0 ? 'pass_with_warnings' : 'pass',
    reasons,
  };
}
