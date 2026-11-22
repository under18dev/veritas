import type { StageStatus, VerificationStatus } from './schema/status.js';

/**
 * Decision kernel of the run policy: maps an abstract evidence record (counts and flags) to the rule that
 * decides the run, the verdict and the exit code. `evaluatePolicy` in `policy.ts` is the shell: it counts the
 * findings, stages, claims and thresholds, calls this kernel and writes the reasons.
 *
 * The file is kept in the subset that the formal translator reads, so that the rules are proved within a
 * bounded model:
 * - no runtime imports (type-only imports are fine) and calls only to functions in this file;
 * - parameters and results are numbers, booleans or flat records of numbers and booleans;
 * - inside the kernel functions, only `const`, `if`, the conditional operator, `&&`, `||`, `!` and comparisons;
 *   no `let`, `switch`, loops, array methods, `??` or `as` (the lookup tables outside the functions may use
 *   `as const`);
 * - every count is compared with 0 on its own, never summed first, so that the rules mean the same over a model
 *   whose integer domain includes negative numbers (a negative count is treated like 0).
 *
 * Enumerations are encoded as small integers where the translator has to read them (rule and verdict codes).
 *
 * The `invariant_*` predicates are declared as `holds_for_all` properties in the repository's own
 * `.veritas/config.json`; `veritas prove --engine both` proves each of them within the model with Z3 and with
 * the Lean kernel (`scripts/check-self-verification.mjs` checks the run). The proof covers this kernel only, not
 * how `evaluatePolicy` counts the evidence it passes in. An exhaustive test over a reduced domain checks the same
 * predicates without a solver. Not translatable today: the stage and claim classifiers take a string literal
 * union, and `verdictName` returns one and reads an array.
 */

/** `pass` is only possible when every stage succeeded and nothing is inconclusive. */
export type PolicyVerdict = 'pass' | 'pass_with_warnings' | 'policy_failure' | 'tool_error' | 'inconclusive';

/** Verdicts indexed by their code in this kernel. */
export const POLICY_VERDICTS: readonly PolicyVerdict[] = [
  'pass',
  'pass_with_warnings',
  'policy_failure',
  'tool_error',
  'inconclusive',
];

/** Rule codes returned by `policyRule`, in the order the rules are tried. */
export const POLICY_RULE = {
  /** A configured threshold (`maxNewSurvivors`, `minPropertyCoverage`) failed. */
  thresholdFailure: 0,
  /** A confirmed specification violation with `confirmedViolation: fail`. */
  confirmedViolation: 1,
  /** A stage failed or errored. */
  toolError: 2,
  /** Something is inconclusive and `inconclusiveBehavior: fail`. */
  inconclusive: 3,
  /** Success, with warnings to report (violations reported as warnings, open findings or inconclusive items). */
  passWithWarnings: 4,
  /** Success with nothing to report. */
  pass: 5,
} as const;

/** Abstract evidence the policy decides on. Every count is the number of items of that kind in the run. */
export interface PolicyCounts {
  /** Confirmed findings of a violation kind (spec/implementation mismatch, counterexample, violation candidate). */
  confirmedViolations: number;
  /** `policy.confirmedViolation === 'fail'`. */
  failOnConfirmedViolation: boolean;
  /** Stages whose status is a tool failure (`failed`, `error`). */
  toolErrors: number;
  /** Stages whose status is inconclusive (`partial`, `skipped`, `unsupported`, `timeout`, `cancelled`). */
  inconclusiveStages: number;
  /** Formal claims whose status is inconclusive (`unknown`, `timeout`, `unsupported`, `semantic_mismatch`, `error`). */
  inconclusiveClaims: number;
  /** Configured thresholds that were measured and failed. */
  thresholdFailures: number;
  /** Configured thresholds that could not be measured. */
  thresholdUndecided: number;
  /** Non-informational findings that are not confirmed violations. */
  openFindings: number;
  /** `policy.inconclusiveBehavior === 'fail'` (`warn` and `ignore` decide the same and differ only in wording). */
  failOnInconclusive: boolean;
}

/** A stage status that means a tool failure. */
export function isToolFailureStage(status: StageStatus): boolean {
  return status === 'failed' || status === 'error';
}

/** A stage status that means the stage could not produce its full result. */
export function isInconclusiveStage(status: StageStatus): boolean {
  return (
    status === 'partial' ||
    status === 'skipped' ||
    status === 'unsupported' ||
    status === 'timeout' ||
    status === 'cancelled'
  );
}

/** A formal claim status that is neither a proof within the model nor a counterexample. */
export function isInconclusiveClaim(status: VerificationStatus): boolean {
  return (
    status === 'unknown' ||
    status === 'timeout' ||
    status === 'unsupported' ||
    status === 'semantic_mismatch' ||
    status === 'error'
  );
}

/**
 * The rule that decides the run (a `POLICY_RULE` code). Threshold failures come first, then confirmed
 * violations, tool errors and inconclusive results; anything left is a success, clean only when there is
 * nothing at all to report.
 */
export function policyRule(c: PolicyCounts): number {
  if (c.thresholdFailures > 0) return 0;

  if (c.confirmedViolations > 0 && c.failOnConfirmedViolation) return 1;

  if (c.toolErrors > 0) return 2;

  const inconclusive = c.inconclusiveStages > 0 || c.inconclusiveClaims > 0 || c.thresholdUndecided > 0;

  if (inconclusive && c.failOnInconclusive) return 3;

  if (c.confirmedViolations > 0 || c.openFindings > 0 || inconclusive) return 4;

  return 5;
}

/** Verdict code (an index into `POLICY_VERDICTS`) of a rule code. */
export function verdictOfRule(rule: number): number {
  if (rule === 0 || rule === 1) return 2;

  if (rule === 2) return 3;

  if (rule === 3) return 4;

  if (rule === 4) return 1;

  return 0;
}

/** Exit code of a verdict code: 0 success, 1 policy failure, 3 tool error, 4 inconclusive. Never 2. */
export function exitCodeOfVerdict(verdict: number): number {
  if (verdict === 2) return 1;

  if (verdict === 3) return 3;

  if (verdict === 4) return 4;

  return 0;
}

/** Name of a verdict code. Throws on a code outside `POLICY_VERDICTS`. */
export function verdictName(verdict: number): PolicyVerdict {
  const name = POLICY_VERDICTS[verdict];

  if (name === undefined) throw new Error(`unknown policy verdict code ${verdict}`);

  return name;
}

// ---------------------------------------------------------------------------------------------------------------
// Invariants. Each predicate must be true for every record. They are declared properties of the repository's
// self-verification (proved within the model) and are also checked by the exhaustive test over a reduced domain.

/** `pass` only when there is nothing at all to report. */
export function invariant_passMeansNothingOpen(c: PolicyCounts): boolean {
  const verdict = verdictOfRule(policyRule(c));

  return (
    verdict !== 0 ||
    (c.confirmedViolations <= 0 &&
      c.toolErrors <= 0 &&
      c.inconclusiveStages <= 0 &&
      c.inconclusiveClaims <= 0 &&
      c.thresholdFailures <= 0 &&
      c.thresholdUndecided <= 0 &&
      c.openFindings <= 0)
  );
}

/** An inconclusive stage, claim or threshold is never a clean pass, whatever `inconclusiveBehavior` says. */
export function invariant_inconclusiveIsNeverPass(c: PolicyCounts): boolean {
  const verdict = verdictOfRule(policyRule(c));
  const inconclusive = c.inconclusiveStages > 0 || c.inconclusiveClaims > 0 || c.thresholdUndecided > 0;

  return !inconclusive || verdict !== 0;
}

/** Exit code 0 only for `pass` or `pass_with_warnings`. */
export function invariant_successExitOnlyWhenPassing(c: PolicyCounts): boolean {
  const verdict = verdictOfRule(policyRule(c));

  return exitCodeOfVerdict(verdict) !== 0 || verdict === 0 || verdict === 1;
}

/** The exit code follows the verdict: failure 1, tool error 3, inconclusive 4, success 0, never 2. */
export function invariant_exitCodeFollowsVerdict(c: PolicyCounts): boolean {
  const verdict = verdictOfRule(policyRule(c));
  const exit = exitCodeOfVerdict(verdict);

  return (
    exit !== 2 &&
    (verdict !== 2 || exit === 1) &&
    (verdict !== 3 || exit === 3) &&
    (verdict !== 4 || exit === 4) &&
    ((verdict !== 0 && verdict !== 1) || exit === 0)
  );
}

/** A failed threshold, or a confirmed violation with `confirmedViolation: fail`, always exits 1. */
export function invariant_failuresExitOne(c: PolicyCounts): boolean {
  const exit = exitCodeOfVerdict(verdictOfRule(policyRule(c)));

  return (
    (c.thresholdFailures <= 0 && !(c.confirmedViolations > 0 && c.failOnConfirmedViolation)) || exit === 1
  );
}

/** A tool error never exits 0. */
export function invariant_toolErrorNeverSucceeds(c: PolicyCounts): boolean {
  const exit = exitCodeOfVerdict(verdictOfRule(policyRule(c)));

  return c.toolErrors <= 0 || exit !== 0;
}

/**
 * With `inconclusiveBehavior: fail`, an inconclusive item exits 4 unless a policy failure or a tool error
 * takes precedence.
 */
export function invariant_inconclusiveFailExitsFour(c: PolicyCounts): boolean {
  const exit = exitCodeOfVerdict(verdictOfRule(policyRule(c)));
  const inconclusive = c.inconclusiveStages > 0 || c.inconclusiveClaims > 0 || c.thresholdUndecided > 0;
  const precedes =
    c.thresholdFailures > 0 || (c.confirmedViolations > 0 && c.failOnConfirmedViolation) || c.toolErrors > 0;

  return !c.failOnInconclusive || !inconclusive || precedes || exit === 4;
}

/** Exit code 1 only for a failed threshold or a confirmed violation with `confirmedViolation: fail`. */
export function invariant_exitOneMeansPolicyFailure(c: PolicyCounts): boolean {
  const exit = exitCodeOfVerdict(verdictOfRule(policyRule(c)));

  return exit !== 1 || c.thresholdFailures > 0 || (c.confirmedViolations > 0 && c.failOnConfirmedViolation);
}

/** Exit code 3 only for a stage that failed or errored. */
export function invariant_exitThreeMeansToolError(c: PolicyCounts): boolean {
  const exit = exitCodeOfVerdict(verdictOfRule(policyRule(c)));

  return exit !== 3 || c.toolErrors > 0;
}

/** Exit code 4 only with `inconclusiveBehavior: fail` and something inconclusive. */
export function invariant_exitFourMeansInconclusiveFail(c: PolicyCounts): boolean {
  const exit = exitCodeOfVerdict(verdictOfRule(policyRule(c)));
  const inconclusive = c.inconclusiveStages > 0 || c.inconclusiveClaims > 0 || c.thresholdUndecided > 0;

  return exit !== 4 || (c.failOnInconclusive && inconclusive);
}

/**
 * Open findings (suspected findings, confirmed findings of a kind that is not a violation, and violations
 * reported as warnings) never make the exit code non-zero: without a failed threshold, a failing confirmed
 * violation, a tool error or a failing inconclusive item, the exit code is 0 whatever `openFindings` is.
 */
export function invariant_openFindingsNeverFail(c: PolicyCounts): boolean {
  const exit = exitCodeOfVerdict(verdictOfRule(policyRule(c)));
  const inconclusive = c.inconclusiveStages > 0 || c.inconclusiveClaims > 0 || c.thresholdUndecided > 0;
  const failing =
    c.thresholdFailures > 0 ||
    (c.confirmedViolations > 0 && c.failOnConfirmedViolation) ||
    c.toolErrors > 0 ||
    (c.failOnInconclusive && inconclusive);

  return failing || exit === 0;
}
