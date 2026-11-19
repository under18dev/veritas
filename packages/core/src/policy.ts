import type { VeritasConfig } from './config/schema.js';
import { ExitCode } from './exit-codes.js';
import type { Finding } from './schema/finding.js';
import type { StageResult } from './schema/run.js';

export interface PolicyDecision {
  exitCode: ExitCode;
  reasons: string[];
}

/**
 * Map findings and stage results to an exit code. Only confirmed findings can fail the policy;
 * suspected findings never do. Unknown or unusable stages are inconclusive, never success.
 */
export function evaluatePolicy(
  policy: VeritasConfig['policy'],
  findings: Finding[],
  stages: StageResult[],
): PolicyDecision {
  const reasons: string[] = [];
  const toolErrors = stages.filter((s) => s.status === 'error');
  const confirmedViolations = findings.filter(
    (f) =>
      f.certainty === 'confirmed' &&
      (f.kind === 'spec_implementation_mismatch' ||
        f.kind === 'counterexample' ||
        f.kind === 'spec_violation_candidate'),
  );
  const inconclusive = stages.filter(
    (s) => s.status === 'partial' || s.status === 'unsupported' || s.status === 'cancelled',
  );

  if (confirmedViolations.length > 0 && policy.confirmedViolation === 'fail') {
    reasons.push(`${confirmedViolations.length} confirmed specification violation(s)`);
    return { exitCode: ExitCode.PolicyFailure, reasons };
  }
  if (toolErrors.length > 0) {
    reasons.push(`stage error(s): ${toolErrors.map((s) => s.stage).join(', ')}`);
    return { exitCode: ExitCode.ToolError, reasons };
  }
  if (inconclusive.length > 0 && policy.inconclusiveBehavior === 'fail') {
    reasons.push(`inconclusive stage(s): ${inconclusive.map((s) => `${s.stage}=${s.status}`).join(', ')}`);
    return { exitCode: ExitCode.Inconclusive, reasons };
  }
  if (inconclusive.length > 0)
    reasons.push(`inconclusive stage(s) reported as ${policy.inconclusiveBehavior}`);
  if (confirmedViolations.length > 0) reasons.push('confirmed violations reported as warnings by policy');
  return { exitCode: ExitCode.Success, reasons };
}
