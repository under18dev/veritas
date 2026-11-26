import { timingSafeEqual } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  gitCommit,
  gitOutput,
  type ImprovementOutcome,
  loadConfig,
  logEvent,
  type MeasurementSnapshot,
  PatchAttempt,
  type Property,
  redact,
  resolveInsideRoot,
  type StageName,
  sha256,
  stableId,
  type TestRunnerProvider,
  type TestRunResult,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import { readArtifact, recordedRunOptions, runVeritas, testRunnerFor } from '@under18dev/veritas-engine';
import { type MutationRunResult, runMutation } from '@under18dev/veritas-mutation-adapter';
import { applyApprovals, loadApprovals } from '@under18dev/veritas-property-engine';
import { applyUnavailableReason } from './availability.js';
import { type DependencySnapshot, diffDependencies, snapshotDependencies } from './dependencies.js';
import { expectedFromSpec } from './oracle.js';
import { renderTestFile } from './render.js';
import { ImprovementApproval, type PatchFile, type PlanDocument } from './schema.js';
import { approvalTokenFor, assertPlanId, attemptCount, readPlan, writePlanArtifact } from './store.js';
import { validatePatch } from './validate.js';
import {
  createWorkspace,
  diffSnapshots,
  projectHash,
  removeWorkspace,
  snapshotTree,
  statTree,
  statWorkspaceModules,
  treeHash,
  undoWrites,
  unexpectedChanges,
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
   * the patched tests run, where code run by an added test would run. The real repository only ever receives the
   * approved plan content; what it changes in the workspace or in the shared dependencies is detected like a change
   * made by such a test.
   */
  afterPatchInWorkspace?: (workspace: string) => void | Promise<void>;
  /** Test hook like `afterPatchInWorkspace`, run after the baseline runs, as code run by an existing test would. */
  afterBaselineInWorkspace?: (workspace: string) => void | Promise<void>;
  /**
   * Test hook like `afterPatchInWorkspace`, run after the patched mutation run and the re-evaluation, as code run by
   * an added test during those runs would.
   */
  afterPatchedRunsInWorkspace?: (workspace: string) => void | Promise<void>;
  /** Who approves (recorded); defaults to VERITAS_ACTOR, then the git user name. */
  actor?: string;
  /** Entry point recorded with the approval (default `api`). */
  via?: 'cli' | 'mcp' | 'api';
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
function planProblems(
  root: string,
  doc: PlanDocument,
  config: VeritasConfig,
  testRunner: TestRunnerProvider,
): string[] {
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

    if (
      !propertyId ||
      tests.length === 0 ||
      renderTestFile(f.path, propertyId, tests, testRunner.templates(root)) !== f.content
    ) {
      problems.push(`${f.path}: content differs from the rendering of the planned tests`);
    }
  }

  return problems;
}

function snapshot(
  tests: TestRunResult & { status: 'ok' },
  mutation: MutationRunResult,
  claimStatuses: Record<string, string>,
): MeasurementSnapshot {
  return {
    testsPassed: tests.passed,
    testsFailed: tests.failed,
    mutantsKilled: mutation.counts.killed ?? 0,
    mutantsSurvived: mutation.counts.survived ?? 0,
    claimStatuses,
  };
}

/** Formal and property-based results of the run the plan was made from: the state before the patch. */
/**
 * Re-evaluate the formal and property-based results on the patched workspace: prove, plus the mutate and pbt
 * stages if the plan's run had them, with that run's options (see below), offline. Claims that depend on test
 * inputs (distinguishability) see the new tests. The run is written inside the workspace, never the repository.
 */
async function reassess(
  workspace: string,
  root: string,
  runId: string,
  options: { allowCodeConfig?: boolean; signal?: AbortSignal },
): Promise<{ runId: string; statuses: Record<string, string>; failed: string[] }> {
  // Paths in the copy are checked to stay inside it: code run there may have replaced `.veritas` with a link.
  mkdirSync(resolveInsideRoot(workspace, '.veritas'), { recursive: true });
  for (const file of ['config.json', 'approvals.json']) {
    const from = path.join(root, '.veritas', file);
    const to = resolveInsideRoot(workspace, path.join('.veritas', file));
    // The repository's file, or none: never one the runs in the copy may have left there. Whatever is at the
    // destination is removed first (a link itself, not its target) and the file is copied exclusively. A destination
    // or `.veritas` that resolves outside the copy (a link leading out) is never touched: resolveInsideRoot throws,
    // and the attempt ends as an error.
    rmSync(to, { force: true });
    if (existsSync(from))
      copyFileSync(from, resolveInsideRoot(workspace, path.join('.veritas', file)), constants.COPYFILE_EXCL);
  }
  const original = readArtifact(root, runId, 'run').data;
  // Mutant relations (equivalence, distinguishability, detection) need the mutate stage as well.
  const had = new Set(original.stages.map((s) => s.stage));
  const optional: StageName[] = ['mutate', 'pbt'];
  const stages: StageName[] = [
    'index',
    'discover',
    'spec',
    'map',
    ...optional.filter((stage) => had.has(stage)),
    'prove',
  ];
  // Everything the run was made with, except the mutation input: like the before/after measurement, the copy
  // always runs mutator on all mutants, because an imported report or a `--since` selection describes the code
  // before the patch.
  const { mutationReport: _report, since: _since, ...recorded } = recordedRunOptions(original);
  const summary = await runVeritas({
    ...recorded,
    root: workspace,
    command: 'improve',
    stages,
    offline: true,
    allowCodeConfig: options.allowCodeConfig ?? false,
    // The workspace has no .git: read the revision from the repository so ids and approvals match.
    gitRoot: root,
    isolatedCopy: true,
    signal: options.signal,
  });
  const failed = summary.run.stages
    .filter((s) => s.status === 'error' || s.status === 'failed' || s.status === 'cancelled')
    .map((s) => `${s.stage}=${s.status}`);
  return { runId: summary.runId, statuses: recordedClaimStatuses(workspace, summary.runId), failed };
}

/** Statuses that are no answer: a result that was decided before must not end up as one of these. */
const UNDECIDED = new Set(['unknown', 'timeout', 'error', 'cancelled', 'semantic_mismatch', 'unsupported']);

/**
 * Results decided before the patch (a proof, a counterexample, a passed property test) that are lost on the
 * patched copy, as `id: before -> after`: undecided there, or, for results in `required`, not produced at all.
 * `required` holds the claims that must be produced again (see `requiredClaimIds`). Property-based results may
 * disappear because their id changes with a review decision.
 */
export function lostResults(
  before: Record<string, string>,
  after: Record<string, string>,
  required: ReadonlySet<string> = new Set(),
): string[] {
  return Object.entries(before)
    .filter(([id, status]) => {
      if (UNDECIDED.has(status)) return false;
      const now = after[id];

      return now === undefined ? required.has(id) : UNDECIDED.has(now);
    })
    .map(([id, status]) => `${id}: ${status} -> ${after[id] ?? 'not produced'}`);
}

type MeasuredMutant = { id: string; status: string; killedBy: string[]; coveredBy: string[] };

/**
 * Ids of the mutants the added tests kill: killed after the patch but not before, by at least one test that the
 * baseline mutation run did not know. A mutant that only an existing test happened to kill this time is not counted.
 */
export function killedByNewTests(before: MeasuredMutant[], after: MeasuredMutant[]): Set<string> {
  const known = new Set(before.flatMap((m) => [...m.killedBy, ...m.coveredBy]));
  const killedBefore = new Set(before.filter((m) => m.status === 'killed').map((m) => m.id));

  return new Set(
    after
      .filter(
        (m) => m.status === 'killed' && !killedBefore.has(m.id) && m.killedBy.some((t) => !known.has(t)),
      )
      .map((m) => m.id),
  );
}

/**
 * Why a succeeded mutation run did not run every mutant in scope, or null when it did. Killed counts of such runs
 * cannot be compared before and after a patch: the mutants each run left out differ, so more kills after the patch
 * need not come from the new tests.
 */
export function incompleteMutationRun(
  result: Pick<MutationRunResult, 'timeBudgetExhausted' | 'excludedFiles'>,
): string | null {
  if (result.timeBudgetExhausted?.notRun)
    return `mutator's time budget ran out and ${result.timeBudgetExhausted.notRun} mutant(s) were not run`;

  if (result.excludedFiles?.length)
    return `${result.excludedFiles.length} source file(s) were left out (${result.excludedFiles.join(', ')})`;

  return null;
}

/**
 * Claims of a run that the patched copy must produce again: conformance claims (about the implementation itself) and
 * claims about a mutant, except a mutant the new tests kill (see `killedByNewTests`), whose claims change with its
 * status. A mutant that was already killed before the patch keeps its claims.
 */
export function requiredClaimIds(
  claims: { id: string; kind: string; mutantId?: string | undefined }[],
  newlyKilled: ReadonlySet<string>,
): Set<string> {
  return new Set(
    claims
      .filter((c) => c.kind === 'conformance' || (c.mutantId !== undefined && !newlyKilled.has(c.mutantId)))
      .map((c) => c.id),
  );
}

function runClaims(
  root: string,
  runId: string,
): { id: string; kind: string; mutantId?: string | undefined }[] {
  try {
    return readArtifact(root, runId, 'claims').data;
  } catch {
    return [];
  }
}

function recordedClaimStatuses(root: string, runId: string): Record<string, string> {
  const out: Record<string, string> = {};

  try {
    for (const c of readArtifact(root, runId, 'claims').data) out[c.id] = c.status;
  } catch {
    /* the run had no prove stage */
  }

  try {
    for (const r of readArtifact(root, runId, 'pbt').data) out[r.id] = r.status;
  } catch {
    /* the run had no property-based tests */
  }

  return out;
}

/** How many changed paths a reason lists before it only counts the rest. */
const LISTED_PATHS = 20;

function listPaths(paths: string[]): string {
  return paths.length > LISTED_PATHS
    ? `${paths.slice(0, LISTED_PATHS).join(', ')} and ${paths.length - LISTED_PATHS} more`
    : paths.join(', ');
}

function tamperReason(paths: string[]): string {
  return `the patched runs changed the isolated copy beyond the plan's files (${listPaths(paths)}), so their results are not trustworthy; the patch was discarded and the repository is unchanged`;
}

/**
 * Why the dependencies are not as they were, with what to do about it: installed packages (in a node_modules
 * directory) are restored by reinstalling; files of a package linked from elsewhere (a workspace package) are the
 * user's own, restored from version control.
 */
export function dependencyChangeReason(paths: string[]): string {
  const installed = paths.filter((p) => p.split(path.sep).includes('node_modules'));
  const linked = paths.filter((p) => !p.split(path.sep).includes('node_modules'));
  const fixes = [
    ...(installed.length > 0
      ? ['reinstall the dependencies (remove node_modules and install again from the lockfile)']
      : []),
    ...(linked.length > 0
      ? [`restore the files of the linked packages (${listPaths(linked)}), for example from version control`]
      : []),
  ];

  return `code run in the isolated copy changed ${paths.length} path(s) of the dependencies it shares with the project: ${listPaths(paths)}. Veritas cannot undo this: ${fixes.join(', and ')} before running the tests or Veritas again`;
}

/**
 * Apply an approved plan: measure it in an isolated copy (baseline tests + mutation, patched tests + mutation)
 * and copy the new test files into the repository only when both mutation runs are complete, the killed-mutant count
 * increases, an added test kills a mutant the baseline left alive, and no previously passing test fails. Any failure leaves the repository unchanged.
 *
 * The runs must leave the copy as it was made, apart from the plan's files with exactly the plan's content, and must
 * not change the installed dependencies the copy links to. These checks catch an added test that tampers with its
 * own measurement or writes through the links; they are a safety net, not a security boundary.
 */
/**
 * Remove the isolated copy once an apply has its result. A removal that fails (EBUSY or EPERM on Windows while a
 * process still holds a file of the copy) is logged as a warning and never replaces the result or the error the apply
 * ended with: the copy stays registered for removal when the process exits.
 */
export function removeWorkspaceAfterApply(
  workspace: string,
  remove: (dir: string) => void = removeWorkspace,
): void {
  try {
    remove(workspace);
  } catch (error) {
    logEvent(
      'warn',
      `the isolated copy ${workspace} could not be removed: ${(error as Error).message}; it is removed again when this process exits`,
      { event: 'workspace-not-removed' },
    );
  }
}

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
  // Without mutation testing nothing could show that the added tests improve anything: refused before an approval
  // is recorded, a copy is made or any project code runs.
  const unavailable = applyUnavailableReason(root, testRunnerFor(config));

  if (unavailable !== null)
    throw new VeritasError(
      'user',
      'IMPROVE_APPLY_UNSUPPORTED',
      unavailable,
      'see the planned tests with `veritas improve --dry-run`; nothing was run or written',
    );
  const token = approvalTokenFor(doc);
  const approvalId = stableId('AP', { planId, token });
  const context = {
    runId: doc.runId,
    configHash: loaded.hash,
    sourceHash: doc.runSourceHash,
    gitCommit: gitCommit(root),
  };
  // The approval is recorded before anything runs: who approved this exact content, when and how. Writing
  // approval-<n>.json exclusively claims attempt number n, so concurrent applies never share or overwrite one.
  const env = options.env ?? process.env;
  const { actor, actorSource } = options.actor?.trim()
    ? {
        actor: options.actor.trim(),
        actorSource: options.via === 'mcp' ? ('claimed_by_client' as const) : ('option' as const),
      }
    : env.VERITAS_ACTOR?.trim()
      ? { actor: env.VERITAS_ACTOR.trim(), actorSource: 'env' as const }
      : { actor: gitOutput(root, ['config', 'user.name'])?.trim() || 'unknown', actorSource: 'git' as const };
  let n = attemptCount(root, planId) + 1;

  for (;;) {
    try {
      writePlanArtifact(
        root,
        planId,
        `approval-${n}.json`,
        ImprovementApproval,
        {
          approvalId,
          planId,
          tokenSha256: sha256(options.approvalToken),
          actor,
          actorSource,
          approvedAt: new Date().toISOString(),
          via: options.via ?? 'api',
        },
        context,
        { exclusive: true },
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      n++;
    }
  }
  const base = {
    id: stableId('PA', { planId, n }),
    planId,
    approvalId,
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
  // Installed dependencies as they were before anything ran in the workspace, until they are compared again.
  let dependencies: DependencySnapshot | null = null;
  // Links the dependency check does not follow, said in every attempt rather than implied to be checked.
  let unchecked: string[] = [];
  /** Reasons the dependencies are not as they were (empty when they are); a failed comparison is one too. */
  const dependencyProblems = (): string[] => {
    if (dependencies === null) return [];
    const before = dependencies;
    dependencies = null;

    try {
      const changed = diffDependencies(before, snapshotDependencies(root));

      return changed.length > 0 ? [dependencyChangeReason(changed)] : [];
    } catch (error) {
      return [
        `could not compare the installed dependencies with their state before the runs: ${(error as Error).message}; check them, and reinstall them if in doubt`,
      ];
    }
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
  ): PatchAttempt => {
    // Whatever the measurement concluded, code that wrote into the real dependencies is reported first.
    const problems = dependencyProblems();

    return persist({
      ...base,
      workspace: fields.workspace ?? '',
      before: fields.before ?? null,
      after: fields.after ?? null,
      rolledBack: fields.rolledBack,
      outcome: problems.length > 0 ? 'error' : outcome,
      reasons: [
        ...problems,
        ...reasons,
        ...(unchecked.length > 0
          ? [
              `not checked for writes: ${unchecked.length} link(s) in linked packages that Veritas does not follow (to something that is not a package outside the package's git repository, ignored by git, or holding the package itself) (${listPaths(unchecked)})`,
            ]
          : []),
      ].map((r) => redact(r)),
    });
  };

  const maxIterations = Math.min(doc.budget.maxIterations, MAX_ITERATIONS);

  if (n > maxIterations) {
    return end('blocked', [`iteration budget exhausted: ${n - 1} of ${maxIterations} attempt(s) used`], {
      rolledBack: false,
    });
  }
  const testRunner = testRunnerFor(config);
  const problems = planProblems(root, doc, config, testRunner);

  if (problems.length > 0) {
    return end('blocked', ['the plan fails the safety checks; nothing was written', ...problems], {
      rolledBack: false,
    });
  }

  const deadline = Date.now() + doc.budget.timeBudgetMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const workspace = createWorkspace(root);
  let written: WriteRecord | null = null;
  // Code under test could send SIGUSR1 to this process to open its inspector; a listener keeps it closed. Child
  // processes get --disable-sigusr1 (see `closedInspectorFlags`).
  const ignoreSigusr1 = () => {};
  if (process.platform !== 'win32') process.on('SIGUSR1', ignoreSigusr1);

  try {
    // The copy as made, to tell what the runs in it changed; and the dependencies it links to, which it shares
    // with the project.
    const original = snapshotTree(workspace);
    // Metadata of the copy's files and of the package links in its own node_modules, which the runner and mutator
    // are resolved from.
    const statCopy = () => new Map([...statTree(workspace), ...statWorkspaceModules(workspace)]);
    const originalStat = statCopy();
    // Files changed since the copy was made, other than `files` with exactly their content, or touched at all since
    // `stat` was taken (a file rewritten and restored keeps its content, not its change time).
    const copyChanges = (stat: Map<string, string>, files: PatchFile[]): string[] =>
      [
        ...new Set([
          ...unexpectedChanges(original, snapshotTree(workspace), files),
          ...diffSnapshots(stat, statCopy()),
        ]),
      ].sort();
    dependencies = snapshotDependencies(root);
    unchecked = dependencies.unchecked;
    const measureTests = async (label: string): Promise<TestRunResult> => {
      let run: TestRunResult = { status: 'error', detail: 'not run' };

      for (let i = 0; i <= doc.budget.maxTestRetries; i++) {
        run = await testRunner.execution.run(workspace, {
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
        testRunner,
        config: {
          ...config,
          mutation: { ...config.mutation, timeoutMs: Math.min(config.mutation.timeoutMs, remaining()) },
        },
        reportDir: path.join(workspace, '.veritas', 'improve', `mutation-${label}`),
        // Mutator is found inside the copy only, and starts without the state a test may have left in `.mutator`.
        isolatedCopy: true,
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
    await options.afterBaselineInWorkspace?.(workspace);
    const changedByBaseline = copyChanges(originalStat, []);

    if (changedByBaseline.length > 0) {
      return end(
        'no_safe_improvement',
        [
          `the baseline runs changed files of the isolated copy (${listPaths(changedByBaseline)}), so the measurement is not trustworthy; nothing was applied`,
        ],
        { workspace, rolledBack: false },
      );
    }
    const baselineGap = incompleteMutationRun(mutationBefore);

    if (baselineGap !== null) {
      return end(
        'no_safe_improvement',
        [
          `the baseline mutation run is incomplete: ${baselineGap}, so killed mutants before and after the patch cannot be compared; nothing was applied. Raise mutation.timeoutMs or the plan's time budget, or plan for a narrower scope`,
        ],
        { workspace, rolledBack: false },
      );
    }
    const before = snapshot(testsBefore, mutationBefore, recordedClaimStatuses(root, doc.runId));

    // Patched.
    writeNewFiles(workspace, doc.files);
    const patchedStat = statCopy();
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
    const tampered = copyChanges(patchedStat, doc.files);
    const testsFail = broken.length > 0 || failingNew.length > 0 || newTests.length === 0;

    if (tampered.length > 0 || testsFail) {
      return end(
        'no_safe_improvement',
        [
          ...(tampered.length > 0 ? [tamperReason(tampered)] : []),
          ...(testsFail
            ? [
                'the patched tests do not all pass in the isolated copy; the patch was discarded and the repository is unchanged',
                ...(newTests.length === 0 ? ['no added test was executed'] : []),
                ...broken.map(([key]) => `previously passing test no longer passes: ${key}`),
                ...testsAfter.failures.slice(0, 10),
              ]
            : []),
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
    const patchedGap = incompleteMutationRun(mutationAfter);

    if (patchedGap !== null) {
      return end(
        'no_safe_improvement',
        [
          `the patched mutation run is incomplete: ${patchedGap}, so killed mutants before and after the patch cannot be compared; the patch was discarded`,
        ],
        { workspace, before, rolledBack: true },
      );
    }
    const reassessed = await reassess(workspace, root, doc.runId, options);
    if (reassessed.failed.length > 0) {
      return end(
        'error',
        [
          `formal and property-based re-evaluation failed (${reassessed.failed.join(', ')}, run ${reassessed.runId})`,
          'the patch was discarded',
        ],
        { workspace, before, rolledBack: true },
      );
    }
    // The patched mutation run and the re-evaluation ran the added tests again: check the copy once more before
    // trusting what they measured.
    await options.afterPatchedRunsInWorkspace?.(workspace);
    const tamperedLater = copyChanges(patchedStat, doc.files);

    if (tamperedLater.length > 0) {
      return end('no_safe_improvement', [tamperReason(tamperedLater)], {
        workspace,
        before,
        rolledBack: true,
      });
    }
    const killedBefore = new Set(
      mutationBefore.mutants.filter((m) => m.status === 'killed').map((m) => m.id),
    );
    const newlyKilled = mutationAfter.mutants.filter((m) => m.status === 'killed' && !killedBefore.has(m.id));
    const byNewTests = killedByNewTests(mutationBefore.mutants, mutationAfter.mutants);
    const lost = lostResults(
      before.claimStatuses,
      reassessed.statuses,
      requiredClaimIds(runClaims(root, doc.runId), byNewTests),
    );
    if (lost.length > 0) {
      return end(
        'error',
        [
          `results decided before the patch are undecided after it (run ${reassessed.runId}): ${lost.join('; ')}`,
          'the patch was discarded',
        ],
        { workspace, before, rolledBack: true },
      );
    }
    const after = snapshot(testsAfter, mutationAfter, reassessed.statuses);

    if (after.mutantsKilled <= before.mutantsKilled) {
      return end(
        'no_safe_improvement',
        [
          `killed mutants did not increase (${before.mutantsKilled} -> ${after.mutantsKilled}); the patch was discarded`,
        ],
        { workspace, before, after, rolledBack: true },
      );
    }

    if (byNewTests.size === 0) {
      return end(
        'no_safe_improvement',
        [
          `killed mutants went from ${before.mutantsKilled} to ${after.mutantsKilled}, but no added test killed a mutant the baseline left alive; the patch was discarded`,
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
    const changedDependencies = dependencyProblems();

    if (changedDependencies.length > 0) {
      return end('error', [...changedDependencies, 'nothing was written to the repository'], {
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
    const unexpected = unexpectedChanges(repoBefore, repoAfter, doc.files);

    if (unexpected.length > 0) {
      const leftovers = undoWrites(record);
      written = null;

      return end(
        'error',
        [
          `unexpected repository changes after writing: ${unexpected.join(', ')}; the written files were removed`,
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
        `formal and property-based results re-evaluated in ${reassessed.runId} on the patched copy`,
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
    process.removeListener('SIGUSR1', ignoreSigusr1);
    removeWorkspaceAfterApply(workspace);
  }
}
