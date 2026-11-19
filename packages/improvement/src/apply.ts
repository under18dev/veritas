import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  gitCommit,
  type ImprovementOutcome,
  loadConfig,
  type MeasurementSnapshot,
  PatchAttempt,
  type Property,
  redact,
  sha256,
  stableId,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import { readArtifact } from '@under18dev/veritas-engine';
import { type MutationRunResult, runMutation } from '@under18dev/veritas-mutation-adapter';
import { applyApprovals, loadApprovals } from '@under18dev/veritas-property-engine';
import { expectedFromSpec } from './oracle.js';
import { renderTestFile } from './render.js';
import type { PlanDocument } from './schema.js';
import { approvalTokenFor, assertPlanId, attemptCount, readPlan, writePlanArtifact } from './store.js';
import { validatePatch } from './validate.js';
import { runVitest, type VitestRun } from './vitest.js';
import {
  createWorkspace,
  diffSnapshots,
  projectHash,
  removeWorkspace,
  snapshotTree,
  treeHash,
  undoWrites,
  type WriteRecord,
  writeNewFiles,
} from './workspace.js';

export interface ApplyOptions {
  root: string;
  planId: string;
  approvalToken: string;
  signal?: AbortSignal;
  allowCodeConfig?: boolean;
  /** Environment used for the CI check (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Test hook, not exposed by the CLI: runs after the patch is written into the isolated workspace and before
   * the patched tests run. It can only affect the workspace; the real repository only ever receives the
   * approved plan content.
   */
  afterPatchInWorkspace?: (workspace: string) => void | Promise<void>;
}

/** Hard cap on apply attempts per plan, matching the configuration limit. */
const MAX_ITERATIONS = 20;

/** `CI` set to anything but an explicit false value means a CI environment. */
export function isCi(env: NodeJS.ProcessEnv): boolean {
  const v = env.CI;
  return v !== undefined && v !== '' && !/^(false|0)$/i.test(v);
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Problems that make an approved plan unsafe even with a valid token. */
function planProblems(root: string, doc: PlanDocument, config: VeritasConfig): string[] {
  const problems = validatePatch(root, doc.files, {
    testInclude: config.analysis.testInclude,
    maxPatchFiles: Math.min(doc.budget.maxPatchFiles, config.improvement.maxPatchFiles),
  });
  if (doc.plan?.touchesProductionCode !== false)
    problems.push('the plan is marked as touching production code');
  // Every expected value must still be the one the specification model documents.
  let properties: Map<string, Property>;
  try {
    // Apply the approval ledger as it is now: a property rejected after planning invalidates the plan.
    const recorded = readArtifact(root, doc.runId, 'properties').data.properties;
    properties = new Map(applyApprovals(recorded, loadApprovals(root)).properties.map((p) => [p.id, p]));
  } catch (error) {
    return [...problems, `cannot re-read the specification of run ${doc.runId}: ${(error as Error).message}`];
  }
  for (const t of doc.tests) {
    const p = properties.get(t.propertyId);
    if (!p?.ir) {
      problems.push(`test ${t.id}: property ${t.propertyId} has no formal model in run ${doc.runId}`);
      continue;
    }
    if (p.status === 'conflicted' || p.status === 'rejected' || p.status === 'superseded') {
      problems.push(`test ${t.id}: property ${t.propertyId} is ${p.status}`);
    } else if (p.status !== 'accepted' && !doc.includeProposed) {
      problems.push(`test ${t.id}: property ${t.propertyId} is ${p.status}, not accepted`);
    }
    const assumedNegative = p.assumptions.some((a) => /^assumed:/i.test(a));
    const e = expectedFromSpec(p.ir, t.input, {
      exclude: (c) => assumedNegative && c.guard?.kind === 'unary' && c.guard.op === 'not',
    });
    if (e.status !== 'expected' || e.value !== t.expected) {
      problems.push(
        `test ${t.id}: expected value ${String(t.expected)} is not what the specification documents (${e.status === 'expected' ? String(e.value) : e.reason})`,
      );
    }
  }
  // File contents must be exactly the rendering of the planned tests: no hand-edited assertions.
  for (const f of doc.files) {
    const propertyId = /veritas-(.+)\.test\.[jt]s$/.exec(f.path)?.[1];
    const tests = doc.tests.filter((t) => t.propertyId === propertyId);
    if (!propertyId || tests.length === 0 || renderTestFile(f.path, propertyId, tests) !== f.content) {
      problems.push(`${f.path}: content differs from the rendering of the planned tests`);
    }
  }
  return problems;
}

function snapshot(tests: VitestRun & { status: 'ok' }, mutation: MutationRunResult): MeasurementSnapshot {
  return {
    testsPassed: tests.passed,
    testsFailed: tests.failed,
    mutantsKilled: mutation.counts.killed ?? 0,
    mutantsSurvived: mutation.counts.survived ?? 0,
    // Formal claims are not re-run: only test files change, so implementation claims cannot change.
    claimStatuses: {},
  };
}

/**
 * Apply an approved plan: measure it in an isolated copy (baseline tests + mutation, patched tests + mutation)
 * and copy the new test files into the repository only when the killed-mutant count increases and no
 * previously passing test fails. Any failure leaves the repository unchanged.
 */
export async function applyImprovement(options: ApplyOptions): Promise<PatchAttempt> {
  const { root, planId } = options;
  assertPlanId(planId);
  if (isCi(options.env ?? process.env)) {
    throw new VeritasError(
      'user',
      'IMPROVE_APPLY_IN_CI',
      'applying an improvement is refused in CI (improvement.autoApply is always false)',
      'run `veritas improve --apply` locally after reviewing the plan',
    );
  }
  if (!options.approvalToken) {
    throw new VeritasError(
      'user',
      'APPROVAL_REQUIRED',
      'an approval token is required to apply a plan',
      'pass --approve <token> as printed by `veritas improve --dry-run`',
    );
  }
  const doc = readPlan(root, planId);
  if (!sameToken(options.approvalToken, approvalTokenFor(doc))) {
    throw new VeritasError(
      'user',
      'APPROVAL_MISMATCH',
      `the approval token does not match plan ${planId} (the plan changed or the token is wrong)`,
      'review the plan again with `veritas improve --dry-run` and use the token it prints',
    );
  }
  if (doc.outcome !== 'planned' || !doc.plan) {
    throw new VeritasError(
      'user',
      'PLAN_NOT_APPLICABLE',
      `plan ${planId} has outcome ${doc.outcome}; there is nothing to apply`,
    );
  }
  const loaded = await loadConfig(root, { allowCodeConfig: options.allowCodeConfig ?? false });
  if (loaded.hash !== doc.configHash || projectHash(root) !== doc.projectHash) {
    throw new VeritasError(
      'user',
      'PLAN_STALE',
      `plan ${planId} was made for a different version of the project or configuration`,
      'run `veritas run` and `veritas improve --dry-run` again',
    );
  }
  const config = loaded.config;
  const n = attemptCount(root, planId) + 1;
  const token = approvalTokenFor(doc);
  const base = {
    id: stableId('PA', { planId, n }),
    planId,
    approvalId: stableId('AP', { planId, token }),
    patch: doc.plan.patchPreview,
    ...(doc.implementationFixProposals[0]
      ? { implementationFixProposalId: doc.implementationFixProposals[0].id }
      : {}),
  };
  const persist = (attempt: PatchAttempt): PatchAttempt => {
    writePlanArtifact(root, planId, `attempt-${n}.json`, PatchAttempt, attempt, {
      runId: doc.runId,
      configHash: loaded.hash,
      sourceHash: doc.runSourceHash,
      gitCommit: gitCommit(root),
    });
    return attempt;
  };
  const end = (
    outcome: ImprovementOutcome,
    reasons: string[],
    fields: {
      workspace?: string;
      before?: MeasurementSnapshot | null;
      after?: MeasurementSnapshot | null;
      rolledBack: boolean;
    },
  ): PatchAttempt =>
    persist({
      ...base,
      workspace: fields.workspace ?? '',
      before: fields.before ?? null,
      after: fields.after ?? null,
      rolledBack: fields.rolledBack,
      outcome,
      reasons: reasons.map((r) => redact(r)),
    });

  const maxIterations = Math.min(doc.budget.maxIterations, MAX_ITERATIONS);
  if (n > maxIterations) {
    return end('blocked', [`iteration budget exhausted: ${n - 1} of ${maxIterations} attempt(s) used`], {
      rolledBack: false,
    });
  }
  const problems = planProblems(root, doc, config);
  if (problems.length > 0) {
    return end('blocked', ['the plan fails the safety checks; nothing was written', ...problems], {
      rolledBack: false,
    });
  }

  const deadline = Date.now() + doc.budget.timeBudgetMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const workspace = createWorkspace(root);
  let written: WriteRecord | null = null;
  try {
    const measureTests = async (label: string): Promise<VitestRun> => {
      let run: VitestRun = { status: 'error', detail: 'not run' };
      for (let i = 0; i <= doc.budget.maxTestRetries; i++) {
        run = await runVitest(workspace, {
          timeoutMs: remaining(),
          label: `${label}-${i}`,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (run.status === 'ok' || options.signal?.aborted || Date.now() >= deadline) break;
      }
      return run;
    };
    const measureMutation = (label: string) =>
      runMutation({
        root: workspace,
        config: {
          ...config,
          mutation: { ...config.mutation, timeoutMs: Math.min(config.mutation.timeoutMs, remaining()) },
        },
        reportDir: path.join(workspace, '.veritas', 'improve', `mutation-${label}`),
        ...(options.signal ? { signal: options.signal } : {}),
      });

    // Baseline.
    const testsBefore = await measureTests('before');
    if (testsBefore.status !== 'ok') {
      return end('error', [`baseline test run failed: ${testsBefore.detail}`], {
        workspace,
        rolledBack: false,
      });
    }
    const mutationBefore = await measureMutation('before');
    if (mutationBefore.status !== 'succeeded') {
      return end(
        mutationBefore.status === 'failed' ? 'no_safe_improvement' : 'error',
        [`baseline mutation run is ${mutationBefore.status}: ${mutationBefore.detail ?? ''}`],
        { workspace, rolledBack: false },
      );
    }
    const before = snapshot(testsBefore, mutationBefore);

    // Patched.
    writeNewFiles(workspace, doc.files);
    await options.afterPatchInWorkspace?.(workspace);
    const testsAfter = await measureTests('after');
    if (testsAfter.status !== 'ok') {
      return end('error', [`patched test run failed: ${testsAfter.detail}`, 'the patch was discarded'], {
        workspace,
        before,
        rolledBack: true,
      });
    }
    const newFiles = new Set(doc.files.map((f) => f.path));
    const broken = [...testsBefore.tests].filter(
      ([key, status]) => status === 'passed' && testsAfter.tests.get(key) !== 'passed',
    );
    const newTests = [...testsAfter.tests].filter(([key]) => newFiles.has(key.split('::')[0] as string));
    const failingNew = newTests.filter(([, status]) => status !== 'passed');
    if (broken.length > 0 || failingNew.length > 0 || newTests.length === 0) {
      return end(
        'no_safe_improvement',
        [
          'the patched tests do not all pass in the isolated copy; the patch was discarded and the repository is unchanged',
          ...(newTests.length === 0 ? ['no added test was executed'] : []),
          ...broken.map(([key]) => `previously passing test no longer passes: ${key}`),
          ...testsAfter.failures.slice(0, 10),
        ],
        {
          workspace,
          before,
          after: { ...before, testsPassed: testsAfter.passed, testsFailed: testsAfter.failed },
          rolledBack: true,
        },
      );
    }
    const mutationAfter = await measureMutation('after');
    if (mutationAfter.status !== 'succeeded') {
      return end(
        'error',
        [
          `patched mutation run is ${mutationAfter.status}: ${mutationAfter.detail ?? ''}`,
          'the patch was discarded',
        ],
        { workspace, before, rolledBack: true },
      );
    }
    const after = snapshot(testsAfter, mutationAfter);
    const killedBefore = new Set(
      mutationBefore.mutants.filter((m) => m.status === 'killed').map((m) => m.id),
    );
    const newlyKilled = mutationAfter.mutants.filter((m) => m.status === 'killed' && !killedBefore.has(m.id));
    if (after.mutantsKilled <= before.mutantsKilled) {
      return end(
        'no_safe_improvement',
        [
          `killed mutants did not increase (${before.mutantsKilled} -> ${after.mutantsKilled}); the patch was discarded`,
        ],
        { workspace, before, after, rolledBack: true },
      );
    }

    // Copy exactly the approved files into the repository, then prove nothing else changed.
    if (options.signal?.aborted) {
      return end('error', ['cancelled before writing to the repository'], {
        workspace,
        before,
        after,
        rolledBack: true,
      });
    }
    const repoBefore = snapshotTree(root);
    if (treeHash(repoBefore) !== doc.projectHash) {
      return end('error', ['the repository changed while the plan was being measured; nothing was written'], {
        workspace,
        before,
        after,
        rolledBack: true,
      });
    }
    let record: WriteRecord;
    try {
      record = writeNewFiles(root, doc.files);
      written = record;
    } catch (error) {
      return end(
        'error',
        [`could not write the new test files: ${(error as Error).message}`, 'partial writes were removed'],
        {
          workspace,
          before,
          after,
          rolledBack: true,
        },
      );
    }
    const repoAfter = snapshotTree(root);
    const changed = diffSnapshots(repoBefore, repoAfter);
    const expected = new Map(doc.files.map((f) => [f.path, sha256(f.content)]));
    const unexpected = changed.filter((p) => !expected.has(p) || repoAfter.get(p) !== expected.get(p));
    if (unexpected.length > 0 || changed.length !== expected.size) {
      const leftovers = undoWrites(record);
      written = null;
      return end(
        'error',
        [
          `unexpected repository changes after writing: ${unexpected.join(', ') || 'missing files'}; the written files were removed`,
          ...(leftovers.length ? [`could not remove: ${leftovers.join(', ')}`] : []),
        ],
        { workspace, before, after, rolledBack: true },
      );
    }
    return end(
      'improved',
      [
        `killed mutants ${before.mutantsKilled} -> ${after.mutantsKilled}, survived ${before.mutantsSurvived} -> ${after.mutantsSurvived}`,
        ...(newlyKilled.length ? [`newly killed: ${newlyKilled.map((m) => m.id).join(', ')}`] : []),
        `added: ${doc.files.map((f) => f.path).join(', ')}`,
        'formal claims were not re-evaluated: only test files were added, so the implementation is unchanged',
      ],
      { workspace, before, after, rolledBack: false },
    );
  } catch (error) {
    const leftovers = written ? undoWrites(written) : [];
    return end(
      'error',
      [
        `apply failed: ${(error as Error).message}`,
        written ? 'files written to the repository were removed' : 'the repository was not changed',
        ...(leftovers.length ? [`could not remove: ${leftovers.join(', ')}`] : []),
      ],
      { workspace, rolledBack: true },
    );
  } finally {
    removeWorkspace(workspace);
  }
}
