import { describe, expect, it } from 'vitest';
import {
  ExitCode,
  evaluatePolicy,
  type Finding,
  type FormalClaim,
  type PolicyDecision,
  type PolicyEvidence,
  type StageResult,
  type StageStatus,
  type VerificationStatus,
  VeritasConfig,
} from '../src/index.js';
import {
  exitCodeOfVerdict,
  invariant_exitCodeFollowsVerdict,
  invariant_exitFourMeansInconclusiveFail,
  invariant_exitOneMeansPolicyFailure,
  invariant_exitThreeMeansToolError,
  invariant_failuresExitOne,
  invariant_inconclusiveFailExitsFour,
  invariant_inconclusiveIsNeverPass,
  invariant_openFindingsNeverFail,
  invariant_passMeansNothingOpen,
  invariant_successExitOnlyWhenPassing,
  invariant_toolErrorNeverSucceeds,
  isInconclusiveClaim,
  isInconclusiveStage,
  isToolFailureStage,
  POLICY_RULE,
  POLICY_VERDICTS,
  type PolicyCounts,
  policyRule,
  verdictName,
  verdictOfRule,
} from '../src/policy-decision.js';

type Policy = VeritasConfig['policy'];

const STAGE_STATUSES: StageStatus[] = [
  'succeeded',
  'failed',
  'partial',
  'skipped',
  'unsupported',
  'timeout',
  'error',
  'cancelled',
];
const CLAIM_STATUSES: VerificationStatus[] = [
  'proven_within_model',
  'counterexample_found',
  'unknown',
  'unsupported',
  'timeout',
  'semantic_mismatch',
  'error',
];

// ---------------------------------------------------------------------------------------------------------------
// The implementation of evaluatePolicy before the decision moved to policy-decision.ts, kept as the oracle.

function legacyCheckThresholds(
  policy: Policy,
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

const LEGACY_TOOL_FAILURE: StageStatus[] = ['error', 'failed'];
const LEGACY_INCONCLUSIVE_STAGE: StageStatus[] = [
  'partial',
  'skipped',
  'unsupported',
  'timeout',
  'cancelled',
];
const LEGACY_INCONCLUSIVE_CLAIM: VerificationStatus[] = [
  'unknown',
  'timeout',
  'unsupported',
  'semantic_mismatch',
  'error',
];

function legacyEvaluatePolicy(
  policy: Policy,
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
  const toolErrors = stages.filter((s) => LEGACY_TOOL_FAILURE.includes(s.status));
  const inconclusive = [
    ...stages
      .filter((s) => LEGACY_INCONCLUSIVE_STAGE.includes(s.status))
      .map((s) => `stage ${s.stage}=${s.status}`),
    ...claims
      .filter((c) => LEGACY_INCONCLUSIVE_CLAIM.includes(c.status))
      .map((c) => `claim ${c.id}=${c.status}`),
  ];

  const thresholds = legacyCheckThresholds(policy, stages, evidence);
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

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const stage = (name: StageResult['stage'], status: StageStatus): StageResult => ({
  stage: name,
  status,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 0,
  artifacts: [],
  messages: [],
  usage: { llmTokens: 0, solverMs: 0, mutants: 0, testRuns: 0 },
});

const finding = (id: string, kind: Finding['kind'], certainty: Finding['certainty']): Finding => ({
  id,
  kind,
  title: 't',
  severity: 'high',
  certainty,
  locations: [],
  propertyIds: [],
  sourceIds: [],
  testIds: [],
  mutantIds: [],
  claimIds: [],
  explanation: ['x'],
  nextActions: [],
});

const claim = (status: VerificationStatus): FormalClaim => ({
  id: 'C-1',
  propertyId: 'P-1',
  kind: 'conformance',
  status,
  engine: 'z3',
  engineVersion: '4',
  assurance: 'none',
  modelId: 'm',
  assumptions: [],
  scope: {},
  semanticGaps: [],
  semanticValidation: 'not_attempted',
  durationMs: 0,
});

/** Every subset of `items`. */
function subsets<T>(items: T[]): T[][] {
  const all: T[][] = [[]];

  for (const item of items) for (const s of all.slice()) all.push([...s, item]);

  return all;
}

/** Every combination of the given choices. */
function product<T extends unknown[]>(...choices: { [K in keyof T]: T[K][] }): T[] {
  return choices.reduce<unknown[][]>(
    (all, options) => all.flatMap((prefix) => options.map((o) => [...prefix, o])),
    [[]],
  ) as T[];
}

const base = VeritasConfig.parse({}).policy;
const survivors = (n: number) => Array.from({ length: n }, () => ({ status: 'survived' })) as never[];
const halfCovered = {
  properties: [
    { id: 'P-1', status: 'accepted' },
    { id: 'P-2', status: 'accepted' },
    { id: 'P-3', status: 'proposed' },
  ] as never[],
  assessments: [
    { propertyIds: ['P-1'], outcome: 'meaningful_with_evidence' },
    { propertyIds: ['P-2', 'P-3'], outcome: 'weak_or_incomplete' },
  ] as never[],
};

/** maxNewSurvivors settings with the mutants they are measured on: unset, within the limit, over it. */
const SURVIVOR_THRESHOLDS: [Partial<Policy>, PolicyEvidence][] = [
  [{}, { mutants: survivors(2) }],
  [{ maxNewSurvivors: 1 }, { mutants: survivors(1) }],
  [{ maxNewSurvivors: 1 }, { mutants: survivors(2) }],
];
/** minPropertyCoverage settings with their evidence: unset, met, missed, and two that cannot be measured. */
const COVERAGE_THRESHOLDS: [Partial<Policy>, PolicyEvidence][] = [
  [{}, halfCovered],
  [{ minPropertyCoverage: 0.5 }, halfCovered],
  [{ minPropertyCoverage: 1 }, halfCovered],
  [{ minPropertyCoverage: 0.5 }, { properties: [], assessments: [] }],
  [{ minPropertyCoverage: 0.5 }, { properties: halfCovered.properties }],
];
const FINDINGS = [
  finding('F-1', 'counterexample', 'confirmed'),
  finding('F-2', 'spec_implementation_mismatch', 'confirmed'),
  finding('F-3', 'spec_violation_candidate', 'confirmed'),
  finding('F-4', 'test_gap', 'confirmed'),
  finding('F-5', 'spec_implementation_mismatch', 'suspected'),
  finding('F-6', 'spec_implementation_mismatch', 'informational'),
];

// ---------------------------------------------------------------------------------------------------------------

describe('policy decision kernel', () => {
  it('matches the previous evaluatePolicy over an exhaustive enumeration of a reduced input space', () => {
    const behaviours = product<[Policy['confirmedViolation'], Policy['inconclusiveBehavior']]>(
      ['fail', 'warn'],
      ['fail', 'warn', 'ignore'],
    );
    const mutateStages: (StageStatus | undefined)[] = [undefined, ...STAGE_STATUSES];
    const proveStages: (StageStatus | undefined)[] = [undefined, 'error'];
    const claimSets: FormalClaim[][] = [[], ...CLAIM_STATUSES.map((s) => [claim(s)])];
    const findingSets = subsets(FINDINGS);
    const mismatches: unknown[] = [];
    let cases = 0;

    for (const [confirmedViolation, inconclusiveBehavior] of behaviours)
      for (const [survivorPolicy, survivorEvidence] of SURVIVOR_THRESHOLDS)
        for (const [coveragePolicy, coverageEvidence] of COVERAGE_THRESHOLDS) {
          const policy: Policy = {
            ...base,
            confirmedViolation,
            inconclusiveBehavior,
            ...survivorPolicy,
            ...coveragePolicy,
          };
          const evidence = { ...survivorEvidence, ...coverageEvidence };

          for (const mutate of mutateStages)
            for (const prove of proveStages) {
              const stages = [
                ...(mutate === undefined ? [] : [stage('mutate', mutate)]),
                ...(prove === undefined ? [] : [stage('prove', prove)]),
              ];

              for (const claims of claimSets)
                for (const findings of findingSets) {
                  cases++;
                  const expected = legacyEvaluatePolicy(policy, findings, stages, claims, evidence);
                  const actual = evaluatePolicy(policy, findings, stages, claims, evidence);

                  if (JSON.stringify(actual) !== JSON.stringify(expected) && mismatches.length < 5)
                    mismatches.push({ policy, findings, stages, claims, expected, actual });
                }
            }
        }

    expect(mismatches).toEqual([]);
    expect(cases).toBe(
      behaviours.length *
        SURVIVOR_THRESHOLDS.length *
        COVERAGE_THRESHOLDS.length *
        mutateStages.length *
        proveStages.length *
        claimSets.length *
        findingSets.length,
    );
  }, 60_000);

  it('classifies every stage and claim status', () => {
    expect(STAGE_STATUSES.filter(isToolFailureStage)).toEqual(['failed', 'error']);
    expect(STAGE_STATUSES.filter(isInconclusiveStage)).toEqual([
      'partial',
      'skipped',
      'unsupported',
      'timeout',
      'cancelled',
    ]);
    expect(STAGE_STATUSES.filter((s) => !isToolFailureStage(s) && !isInconclusiveStage(s))).toEqual([
      'succeeded',
    ]);
    expect(CLAIM_STATUSES.filter((s) => !isInconclusiveClaim(s))).toEqual([
      'proven_within_model',
      'counterexample_found',
    ]);
  });

  it('maps rules to verdicts and verdicts to exit codes', () => {
    const rules = Object.values(POLICY_RULE).map((r) => verdictName(verdictOfRule(r)));
    expect(rules).toEqual([
      'policy_failure',
      'policy_failure',
      'tool_error',
      'inconclusive',
      'pass_with_warnings',
      'pass',
    ]);
    expect(POLICY_VERDICTS.map((_, code) => exitCodeOfVerdict(code))).toEqual([
      ExitCode.Success,
      ExitCode.Success,
      ExitCode.PolicyFailure,
      ExitCode.ToolError,
      ExitCode.Inconclusive,
    ]);
    expect(() => verdictName(POLICY_VERDICTS.length)).toThrow(/unknown policy verdict/);
  });

  // An exhaustive test over a reduced domain (every count in {-1, 0, 1, 2}), not a proof: the kernel only
  // compares counts with 0, which this test does not check. Counts are never negative in a run; -1 is there
  // because a model whose integer domain includes negative numbers must reach the same conclusions.
  it('holds every invariant over a reduced domain', () => {
    const counts = [-1, 0, 1, 2];
    const flags = [false, true];
    const records = product<[number, boolean, number, number, number, number, number, number, boolean]>(
      counts,
      flags,
      counts,
      counts,
      counts,
      counts,
      counts,
      counts,
      flags,
    ).map(
      ([
        confirmedViolations,
        failOnConfirmedViolation,
        toolErrors,
        inconclusiveStages,
        inconclusiveClaims,
        thresholdFailures,
        thresholdUndecided,
        openFindings,
        failOnInconclusive,
      ]): PolicyCounts => ({
        confirmedViolations,
        failOnConfirmedViolation,
        toolErrors,
        inconclusiveStages,
        inconclusiveClaims,
        thresholdFailures,
        thresholdUndecided,
        openFindings,
        failOnInconclusive,
      }),
    );
    const invariants = {
      invariant_passMeansNothingOpen,
      invariant_inconclusiveIsNeverPass,
      invariant_successExitOnlyWhenPassing,
      invariant_exitCodeFollowsVerdict,
      invariant_failuresExitOne,
      invariant_toolErrorNeverSucceeds,
      invariant_inconclusiveFailExitsFour,
      invariant_exitOneMeansPolicyFailure,
      invariant_exitThreeMeansToolError,
      invariant_exitFourMeansInconclusiveFail,
      invariant_openFindingsNeverFail,
    };
    expect(records).toHaveLength(4 ** 7 * 4);

    for (const [name, holds] of Object.entries(invariants))
      expect(
        records.filter((r) => !holds(r)),
        name,
      ).toEqual([]);

    const rules = new Set(records.map(policyRule));
    expect([...rules].sort()).toEqual(Object.values(POLICY_RULE).sort());
  });
});
