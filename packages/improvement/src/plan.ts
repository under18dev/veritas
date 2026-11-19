import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  callInSandbox,
  canonicalJson,
  type EncodedValue,
  type Finding,
  type FormalClaim,
  gitCommit,
  type ImprovementBudget,
  type ImprovementPlan,
  loadConfig,
  type Mutant,
  type Property,
  parseSymbolId,
  resolveInsideRoot,
  stableId,
  type TestCase,
  VeritasError,
} from '@veritas/core';
import { type ArtifactData, type ArtifactName, latestRunWith, readArtifact } from '@veritas/engine';
import { applyApprovals, loadApprovals } from '@veritas/property-engine';
import { expectedFromSpec, type SpecClause } from './oracle.js';
import { callText, literal, renderTestFile, unifiedDiff } from './render.js';
import {
  ImplementationFixProposal as FixProposalSchema,
  type ImplementationFixProposal,
  type PatchFile,
  type PlanDocument,
  PlanDocument as PlanDocumentSchema,
  type PlanOutcome,
  type PlanResult,
  type ProposedTest,
  type ScalarValue,
  type SkippedTarget,
  type SpecViolationCandidate,
} from './schema.js';
import { approvalTokenFor, readPlan, type StoreContext, writePlanArtifact } from './store.js';
import { validatePatch } from './validate.js';
import { projectHash } from './workspace.js';

export interface PlanOptions {
  root: string;
  /** Run to plan from; defaults to the latest run with findings. */
  runId?: string;
  maxIterations?: number;
  allowCodeConfig?: boolean;
  signal?: AbortSignal;
  /**
   * Also use proposed (not yet accepted) properties as the oracle. Off by default: without an explicit opt-in,
   * only accepted specifications may supply expected values.
   */
  includeProposed?: boolean;
}

const UNACCEPTED = 'not accepted';

type Conflict = ArtifactData<'properties'>['conflicts'][number];

/** Default wall-clock budget for one apply (baseline + patched test and mutation runs). */
export const DEFAULT_TIME_BUDGET_MS = 900_000;
export const DEFAULT_TEST_RETRIES = 1;

function optional<N extends ArtifactName>(root: string, runId: string, name: N): ArtifactData<N> | null {
  try {
    return readArtifact(root, runId, name).data;
  } catch (error) {
    if (error instanceof VeritasError && error.code === 'ARTIFACT_MISSING') return null;
    throw error;
  }
}

function scalarInput(raw: Record<string, unknown>): Record<string, ScalarValue> | null {
  const out: Record<string, ScalarValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'boolean' || (typeof v === 'string' && /^-?\d+$/.test(v))) out[k] = v;
    else if (typeof v === 'number' && Number.isSafeInteger(v)) out[k] = String(v);
    else return null;
  }
  return out;
}

/** Inputs on both sides of a threshold `param op value`. */
export function boundaryValues(operator: string, value: string): string[] {
  const v = BigInt(value);
  const around: Record<string, bigint[]> = {
    '>=': [v - 1n, v],
    '>': [v, v + 1n],
    '<=': [v, v + 1n],
    '<': [v - 1n, v],
    '==': [v - 1n, v, v + 1n],
  };
  return (around[operator] ?? []).map(String);
}

function sameScalar(expected: ScalarValue, js: EncodedValue | undefined): boolean {
  if (!js) return false;
  if (typeof expected === 'boolean') return js.t === 'boolean' && js.v === expected;
  return js.t === 'number' && js.v === expected;
}

function describeEncoded(js: EncodedValue | undefined): string {
  if (!js) return 'no result';
  if (js.t === 'undefined' || js.t === 'null') return js.t;
  if (js.t === 'throw') return `throws ${js.v}`;
  return String(js.v);
}

/** Where new test files go: the most common top-level directory of existing test files, else `test`. */
function testDirectory(tests: TestCase[]): string {
  const counts = new Map<string, number>();
  for (const t of tests) {
    const parts = t.file.split('/');
    if (parts.length > 1 && parts[0]) counts.set(parts[0], (counts.get(parts[0]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'test';
}

interface Target {
  property: Property;
  input: Record<string, ScalarValue>;
  origin: 'survived_mutant' | 'boundary';
  mutant?: Mutant;
  claim?: FormalClaim;
  finding?: Finding;
  gap: string;
}

/**
 * Plan test-only improvements from a run's artifacts. Targets are survived specification-relevant mutants
 * with a distinguishing input and uncovered boundaries of formalized properties. Expected values are computed
 * from the specification model only; tests that the implementation fails become spec violation candidates.
 */
export async function planImprovement(options: PlanOptions): Promise<PlanResult> {
  const { root } = options;
  const loaded = await loadConfig(root, { allowCodeConfig: options.allowCodeConfig ?? false });
  const config = loaded.config;
  const runId = options.runId ?? latestRunWith(root, 'findings');
  if (!runId) {
    throw new VeritasError(
      'user',
      'NO_RUN',
      'no run with findings exists yet',
      'run `veritas run --profile deep` first',
    );
  }
  const maxIterations = options.maxIterations ?? config.improvement.maxIterations;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 20) {
    throw new VeritasError('user', 'BUDGET_INVALID', 'max iterations must be an integer from 1 to 20');
  }
  const budget: ImprovementBudget = {
    maxIterations,
    maxPatchFiles: config.improvement.maxPatchFiles,
    maxTestRetries: DEFAULT_TEST_RETRIES,
    timeBudgetMs: DEFAULT_TIME_BUDGET_MS,
    tokenBudget: 0,
    solverTimeoutMs: config.formal.maxSolverMs,
  };

  const propertiesArtifact = readArtifact(root, runId, 'properties');
  const { conflicts, mapping } = propertiesArtifact.data;
  // Review status comes from the current approval ledger, not from the status recorded when the run happened.
  const properties = applyApprovals(propertiesArtifact.data.properties, loadApprovals(root)).properties;
  const includeProposed = Boolean(options.includeProposed);
  const claims = optional(root, runId, 'claims') ?? [];
  const mutation = optional(root, runId, 'mutation');
  const testMap = optional(root, runId, 'testMap');
  const findings = optional(root, runId, 'findings') ?? [];
  const reasons: string[] = [];
  const skipped: SkippedTarget[] = [];
  if (!mutation) reasons.push(`run ${runId} has no mutation results; only boundary gaps were considered`);
  if (!testMap) reasons.push(`run ${runId} has no test map; boundary coverage of existing tests is unknown`);

  const staleStatements = new Set(mapping.filter((m) => m.status === 'stale').map((m) => m.statementId));
  const byId = new Map(properties.map((p) => [p.id, p]));

  /** Why a property cannot supply expected values, or null when it can. */
  const ineligible = (p: Property): string | null => {
    if (!p.ir) return 'the property has no formal model';
    if (p.status === 'rejected' || p.status === 'superseded') return `the property is ${p.status}`;
    if (p.status !== 'accepted' && p.status !== 'conflicted' && !includeProposed) {
      return `${UNACCEPTED}: the property is ${p.status}; accept it with \`veritas spec accept ${p.id}\` or pass --include-proposed`;
    }
    if (p.origin === 'inferred' || p.origin === 'observed') {
      return `the property is ${p.origin} from the implementation; it cannot supply expected values`;
    }
    if (p.statementIds.length > 0 && p.statementIds.every((s) => staleStatements.has(s))) {
      return 'every source statement of the property is marked stale';
    }
    if (p.targetSymbols.length !== 1) return 'the property does not target exactly one function';
    return null;
  };

  // 1. Collect targets.
  const targets: Target[] = [];
  for (const m of mutation?.mutants ?? []) {
    if (m.status !== 'survived' || m.relevance !== 'spec_relevant') continue;
    const claim = claims.find((c) => c.kind === 'bounded_equivalence' && c.mutantId === m.id);
    if (claim?.status !== 'counterexample_found' || !claim.counterexample) {
      skipped.push({
        propertyId: claim?.propertyId ?? null,
        mutantId: m.id,
        reason: claim
          ? `bounded equivalence check is ${claim.status}; no distinguishing input`
          : 'no bounded equivalence check for this mutant',
      });
      continue;
    }
    const property = byId.get(claim.propertyId);
    const input = scalarInput(claim.counterexample);
    if (!property || !input) {
      skipped.push({
        propertyId: claim.propertyId,
        mutantId: m.id,
        reason: property ? 'distinguishing input is not a scalar' : 'claim refers to an unknown property',
      });
      continue;
    }
    targets.push({
      property,
      input,
      origin: 'survived_mutant',
      mutant: m,
      claim,
      ...findingFor(findings, (f) => f.kind === 'survived_mutant' && f.mutantIds.includes(m.id)),
      gap: `${m.original} -> ${m.replacement} at ${m.location.file}:${m.location.range?.start ?? '?'} survives every test; ${JSON.stringify(input)} distinguishes it (${claim.id})`,
    });
  }
  for (const p of properties) {
    if (!p.ir || !p.predicate || p.ir.params.length !== 1) continue;
    const symbol = p.targetSymbols[0];
    const covered = new Set(
      (testMap?.tests ?? []).flatMap((t) =>
        t.targetCalls
          .filter((c) => c.symbol === symbol && c.asserted && c.args.length === 1 && c.args[0] !== null)
          .map((c) => c.args[0] as string),
      ),
    );
    for (const value of boundaryValues(p.predicate.operator, p.predicate.value)) {
      if (testMap && covered.has(value)) continue;
      const input = { [p.predicate.param]: value };
      targets.push({
        property: p,
        input,
        origin: 'boundary',
        ...findingFor(
          findings,
          (f) => f.propertyIds.includes(p.id) && (f.kind === 'test_gap' || f.kind === 'survived_mutant'),
        ),
        gap: `boundary of ${p.predicate.param} ${p.predicate.operator} ${p.predicate.value}: ${p.predicate.param}=${value} is not checked by an asserting test`,
      });
    }
  }

  // 2. Drop properties that cannot supply expected values; stop on any specification conflict.
  const stops: string[] = [];
  const usable: Target[] = [];
  for (const t of targets) {
    const why = ineligible(t.property);
    if (why) {
      skipped.push({ propertyId: t.property.id, mutantId: t.mutant?.id, input: t.input, reason: why });
      continue;
    }
    const conflict = conflictOf(t.property, conflicts);
    if (t.property.status === 'conflicted' || conflict) {
      stops.push(conflictReason(t.property, conflict, byId));
      continue;
    }
    usable.push(t);
  }
  const context: StoreContext = {
    runId,
    configHash: loaded.hash,
    sourceHash: propertiesArtifact.meta.sourceHash,
    gitCommit: gitCommit(root),
  };
  const budgetedDoc = {
    runId,
    budget,
    projectHash: projectHash(root),
    includeProposed,
    configHash: loaded.hash,
    runSourceHash: propertiesArtifact.meta.sourceHash,
  };
  const unaccepted = skipped.filter((x) => x.reason.startsWith(UNACCEPTED));
  if (usable.length === 0 && unaccepted.length > 0) {
    stops.push(...[...new Set(unaccepted.map((x) => x.reason))]);
  }
  if (stops.length > 0) {
    return finish(root, context, {
      ...budgetedDoc,
      outcome: 'needs_spec_decision',
      plan: null,
      files: [],
      tests: [],
      specViolationCandidates: [],
      implementationFixProposals: [],
      skipped,
      reasons: [
        'a targeted property is part of a specification conflict: improvement stops until a human decides the specification (`veritas spec accept|reject`)',
        ...new Set(stops),
        ...reasons,
      ],
    });
  }

  // 3. Expected values from the specification model only.
  const tests = new Map<string, ProposedTest>();
  for (const t of usable) {
    const p = t.property;
    const ir = p.ir as NonNullable<Property['ir']>;
    const { file: module, name: exportName } = parseSymbolId(p.targetSymbols[0] as string);
    const assumedNegative = p.assumptions.some((a) => /^assumed:/i.test(a));
    const expectation = expectedFromSpec(ir, t.input, {
      // A value the formalizer only assumed (not stated by the source) is not used as an expected value.
      exclude: (c: SpecClause) => assumedNegative && c.guard?.kind === 'unary' && c.guard.op === 'not',
    });
    if (expectation.status !== 'expected') {
      skipped.push({ propertyId: p.id, mutantId: t.mutant?.id, input: t.input, reason: expectation.reason });
      continue;
    }
    if (expectation.clause.fn !== exportName) {
      skipped.push({
        propertyId: p.id,
        input: t.input,
        reason: `the documented clause constrains ${expectation.clause.fn}, not ${exportName}`,
      });
      continue;
    }
    const key = canonicalJson({ p: p.id, input: t.input });
    if (tests.has(key)) continue;
    tests.set(key, {
      id: stableId('PT', { propertyId: p.id, input: t.input }),
      propertyId: p.id,
      symbol: p.targetSymbols[0] as string,
      exportName,
      module,
      params: ir.params.map((x) => x.name),
      input: t.input,
      expected: expectation.value,
      origin: t.origin,
      ...(t.mutant ? { mutantId: t.mutant.id } : {}),
      ...(t.claim ? { claimId: t.claim.id } : {}),
      ...(t.finding ? { findingId: t.finding.id } : {}),
      citations: p.citations,
      derivation: `property ${p.id} (${p.formalExpression ?? p.description}): ${
        expectation.clause.guard ? 'the guarding condition holds for this input, so' : ''
      } the specification documents ${literal(expectation.value)}`.replace(/\s+/g, ' '),
    });
  }

  // 4. Classify against the implementation (sandboxed). Failing tests are spec violation candidates.
  const passing: ProposedTest[] = [];
  const candidates: SpecViolationCandidate[] = [];
  const proposals: ImplementationFixProposal[] = [];
  const byModule = new Map<string, ProposedTest[]>();
  for (const t of tests.values()) {
    const k = `${t.module}#${t.exportName}`;
    byModule.set(k, [...(byModule.get(k) ?? []), t]);
  }
  for (const group of byModule.values()) {
    const first = group[0] as ProposedTest;
    let modulePath: string;
    try {
      modulePath = resolveInsideRoot(root, first.module);
    } catch (error) {
      for (const t of group)
        skipped.push({ propertyId: t.propertyId, input: t.input, reason: (error as Error).message });
      continue;
    }
    const sandbox = existsSync(modulePath)
      ? await callInSandbox({
          root,
          modulePath,
          exportName: first.exportName,
          calls: group.map((t) =>
            t.params.map((name): EncodedValue => {
              const v = t.input[name] as ScalarValue;
              return typeof v === 'boolean' ? { t: 'boolean', v } : { t: 'number', v };
            }),
          ),
          timeoutMs: Math.max(5_000, budget.solverTimeoutMs),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : null;
    if (sandbox?.status !== 'ok') {
      const why = sandbox ? `${sandbox.status}: ${sandbox.error}` : `${first.module} does not exist`;
      for (const t of group) {
        skipped.push({
          propertyId: t.propertyId,
          input: t.input,
          reason: `could not check the test against the implementation (${why}); not proposed`,
        });
      }
      continue;
    }
    group.forEach((t, i) => {
      const actual = sandbox.results[i];
      if (sameScalar(t.expected, actual)) {
        passing.push(t);
        return;
      }
      const candidateId = stableId('SVC', { test: t.id, actual });
      const actualText = describeEncoded(actual);
      candidates.push({
        id: candidateId,
        test: t,
        actual: actualText,
        reason: `${callText(t)} returns ${actualText}, but the specification (${t.citations.join(', ') || t.propertyId}) documents ${literal(t.expected)}; the test is not added and its expected value is not changed`,
      });
      proposals.push({
        id: stableId('IFP', { candidateId }),
        kind: 'implementation_fix_proposal',
        propertyId: t.propertyId,
        symbol: t.symbol,
        module: t.module,
        input: t.input,
        expectedBySpecification: t.expected,
        actualByImplementation: actualText,
        citations: t.citations,
        explanation: [
          `${callText(t)} should be ${literal(t.expected)} according to ${t.citations.join(', ') || `property ${t.propertyId}`}, but the implementation returns ${actualText}.`,
          'Either fix the implementation or decide that the specification is wrong; Veritas does not change the expected value to match the implementation.',
          ...(byId.get(t.propertyId)?.status === 'accepted'
            ? []
            : [`property ${t.propertyId} is not accepted yet: confirm the specification first`]),
        ],
        candidateId,
      });
    });
  }

  // 5. One new file per property, within the file budget.
  const dir = testDirectory(testMap?.tests ?? []);
  const perProperty = new Map<string, ProposedTest[]>();
  for (const t of passing) perProperty.set(t.propertyId, [...(perProperty.get(t.propertyId) ?? []), t]);
  const files: PatchFile[] = [];
  const planned: ProposedTest[] = [];
  const fileByTest = new Map<string, string>();
  for (const [propertyId, group] of perProperty) {
    const ext = /\.(m|c)?tsx?$/.test(group[0]?.module ?? '') ? 'ts' : 'js';
    const file = `${dir}/veritas-${propertyId}.test.${ext}`;
    if (files.length >= budget.maxPatchFiles) {
      for (const t of group)
        skipped.push({
          propertyId,
          input: t.input,
          reason: `maxPatchFiles (${budget.maxPatchFiles}) reached`,
        });
      continue;
    }
    if (existsSync(path.join(root, file))) {
      for (const t of group)
        skipped.push({
          propertyId,
          input: t.input,
          reason: `${file} already exists; rerun \`veritas run\` to refresh the gaps`,
        });
      continue;
    }
    files.push({ operation: 'add', path: file, content: renderTestFile(file, propertyId, group) });
    for (const t of group) fileByTest.set(t.id, file);
    planned.push(...group);
  }

  const common = {
    ...budgetedDoc,
    specViolationCandidates: candidates,
    implementationFixProposals: proposals,
    skipped,
  };
  for (const c of candidates) reasons.push(`spec violation candidate: ${c.reason}`);
  if (planned.length === 0) {
    const outcome: PlanOutcome = candidates.length > 0 ? 'needs_spec_decision' : 'no_safe_improvement';
    return finish(root, context, {
      ...common,
      outcome,
      plan: null,
      files: [],
      tests: [],
      reasons: [
        outcome === 'needs_spec_decision'
          ? 'every targeted test fails against the implementation: the implementation or the specification needs a decision'
          : targets.length === 0
            ? 'no survived specification-relevant mutant with a distinguishing input and no uncovered boundary'
            : 'no target could be turned into a test with a specification-derived expected value',
        ...reasons,
      ],
    });
  }

  const problems = validatePatch(root, files, {
    testInclude: config.analysis.testInclude,
    maxPatchFiles: budget.maxPatchFiles,
  });
  const plan = buildPlan(planned, fileByTest, files, budget, usable, byId);
  if (problems.length > 0) {
    return finish(root, context, {
      ...common,
      outcome: 'blocked',
      plan,
      files,
      tests: planned,
      reasons: ['the generated patch fails the safety checks', ...problems, ...reasons],
    });
  }
  return finish(root, context, {
    ...common,
    outcome: 'planned',
    plan,
    files,
    tests: planned,
    reasons,
  });
}

function findingFor(findings: Finding[], match: (f: Finding) => boolean): { finding?: Finding } {
  const finding = findings.find(match);
  return finding ? { finding } : {};
}

function conflictOf(p: Property, conflicts: Conflict[]): Conflict | undefined {
  return conflicts.find((c) => c.propertyIds.includes(p.id) || p.targetSymbols.includes(c.symbol));
}

function conflictReason(p: Property, conflict: Conflict | undefined, byId: Map<string, Property>): string {
  if (!conflict) {
    return `property ${p.id} (${p.citations.join(', ') || p.description}) is conflicted with ${p.conflictsWith.join(', ') || 'another source'}`;
  }
  const members = conflict.propertyIds
    .map((id) => `${id} (${byId.get(id)?.citations.join(', ') || byId.get(id)?.description || 'unknown'})`)
    .join(' vs ');
  return `conflict ${conflict.id} on ${conflict.symbol} (${conflict.param}): ${members}; ${conflict.rationale.join('; ')}`;
}

function buildPlan(
  tests: ProposedTest[],
  fileByTest: Map<string, string>,
  files: PatchFile[],
  budget: ImprovementBudget,
  targets: Target[],
  byId: Map<string, Property>,
): ImprovementPlan {
  const mutants = new Set(tests.flatMap((t) => (t.mutantId ? [t.mutantId] : [])));
  const propertyIds = [...new Set(tests.map((t) => t.propertyId))];
  const gaps = new Map<string, string>();
  for (const t of targets) {
    if (
      !tests.some((x) => x.propertyId === t.property.id && canonicalJson(x.input) === canonicalJson(t.input))
    )
      continue;
    const id = t.finding?.id ?? stableId('G', { propertyId: t.property.id, input: t.input });
    gaps.set(`${id}:${t.gap}`, id);
  }
  const notAccepted = propertyIds.filter((id) => byId.get(id)?.status !== 'accepted');
  return {
    id: 'IP-pending',
    goal: `Add ${tests.length} test(s) whose expected values come from the specification, to kill ${mutants.size} surviving specification-relevant mutant(s) and check uncovered boundaries`,
    targetedPropertyIds: propertyIds,
    observedGaps: [...gaps.entries()].map(([key, findingId]) => ({
      findingId,
      description: key.slice(findingId.length + 1),
    })),
    proposedTestCases: tests.map((t) => ({
      file: fileByTest.get(t.id) ?? '',
      name: `${callText(t)} is ${literal(t.expected)}`,
      input: t.input,
      rationale: t.derivation,
    })),
    patchPreview: unifiedDiff(files),
    expectedImpact: [
      ...(mutants.size > 0 ? [`kill surviving mutant(s): ${[...mutants].join(', ')}`] : []),
      'measured before/after in an isolated copy; applied only if the killed-mutant count increases and no existing test breaks',
    ],
    risks: [
      ...notAccepted.map(
        (id) =>
          `property ${id} is ${byId.get(id)?.status}, not accepted: the expected values rely on a specification nobody has confirmed yet`,
      ),
      'formal claims are not re-evaluated after the patch: only test files are added, so the implementation and its claims are unchanged',
    ],
    commands: [
      'veritas improve --apply --plan <plan-id> --approve <approval-token>',
      'vitest run (baseline and patched, in the isolated copy)',
      'mutator (baseline and patched, in the isolated copy)',
    ],
    budget,
    touchesProductionCode: false,
    createdAt: new Date().toISOString(),
  };
}

type DraftDocument = Omit<PlanDocument, 'planId'>;

/** Assign the plan id, persist the plan (and fix proposals) under `.veritas/improvements/<id>/` and compute the token. */
function finish(root: string, context: StoreContext, draft: DraftDocument): PlanResult {
  const planId = stableId('IP', {
    runId: draft.runId,
    projectHash: draft.projectHash,
    outcome: draft.outcome,
    files: draft.files,
    candidates: draft.specViolationCandidates.map((c) => c.id),
    reasons: draft.reasons,
  });
  const doc: PlanDocument = {
    planId,
    ...draft,
    plan: draft.plan ? { ...draft.plan, id: planId } : null,
  };
  if (doc.plan) {
    doc.plan.commands = doc.plan.commands.map((c) => c.replace('<plan-id>', planId));
  }
  const planFile = writePlanArtifact(root, planId, 'plan.json', PlanDocumentSchema, doc, context);
  if (doc.implementationFixProposals.length > 0) {
    writePlanArtifact(
      root,
      planId,
      'implementation-fix-proposal.json',
      FixProposalSchema.array(),
      doc.implementationFixProposals,
      context,
    );
  }
  // The token covers exactly what was persisted (after validation and redaction).
  const persisted = readPlan(root, planId);
  return {
    planId,
    runId: doc.runId,
    outcome: persisted.outcome,
    plan: persisted.plan,
    approvalToken: persisted.outcome === 'planned' ? approvalTokenFor(persisted) : null,
    specViolationCandidates: persisted.specViolationCandidates,
    implementationFixProposals: persisted.implementationFixProposals,
    skipped: persisted.skipped,
    reasons: persisted.reasons,
    planFile,
  };
}
