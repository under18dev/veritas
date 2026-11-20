import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyImprovement,
  approvalTokenFor,
  projectHash,
  readPlan,
} from '../../packages/improvement/dist/index.js';
import { copyFixture, json, runCli } from './helpers.js';

const LONG = 300_000;

interface PlanJson {
  status: string;
  exitCode: number;
  planId: string;
  outcome: string;
  approvalToken: string | null;
  plan: {
    proposedTestCases: { file: string; name: string; input: Record<string, unknown> }[];
    patchPreview: string;
    targetedPropertyIds: string[];
  } | null;
  specViolationCandidates: { test: { input: Record<string, unknown>; expected: unknown }; actual: string }[];
  implementationFixProposals: { expectedBySpecification: unknown; actualByImplementation: string }[];
  reasons: string[];
}

interface AttemptJson {
  status: string;
  exitCode: number;
  attempt: {
    outcome: string;
    rolledBack: boolean;
    before: {
      mutantsKilled: number;
      mutantsSurvived: number;
      testsPassed: number;
      claimStatuses: Record<string, string>;
    } | null;
    after: {
      mutantsKilled: number;
      mutantsSurvived: number;
      testsPassed: number;
      claimStatuses: Record<string, string>;
    } | null;
    reasons: string[];
  };
}

function gitStatus(dir: string): string {
  return spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
}

/**
 * Copy a fixture, initialise it and run the deep pipeline including proposed properties. Unless `accept` is
 * false, a reviewer then accepts every normative proposed property (conflicted ones need a real decision).
 */
function analyzed(name: string, accept = true): string {
  const dir = copyFixture(name, { git: true, linkDeps: true });
  const init = runCli(['init', '--yes'], dir);

  if (init.status !== 0) throw new Error(init.stderr);
  const run = runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir);

  if (run.status !== 0 && run.status !== 1) throw new Error(run.stderr);

  if (accept) {
    const list = JSON.parse(runCli(['spec', 'list', '--json'], dir).stdout) as {
      properties: { id: string; origin: string; status: string }[];
    };

    for (const p of list.properties.filter((x) => x.origin === 'normative' && x.status === 'proposed')) {
      const decided = runCli(
        ['spec', 'accept', p.id, '--reason', 'matches the README', '--actor', 'reviewer'],
        dir,
      );

      if (decided.status !== 0) throw new Error(decided.stderr);
    }
  }

  return dir;
}

/** Project files only (tool state under .veritas/.mutator and node_modules excluded). */
function projectStatus(dir: string): string[] {
  return gitStatus(dir)
    .split('\n')
    .filter((l) => l && !/^\?\? (\.veritas|\.mutator|node_modules)\//.test(l));
}

describe('improve on agent-loop', () => {
  let dir: string;
  let plan: PlanJson;
  let statusBefore: string;

  beforeAll(() => {
    dir = analyzed('agent-loop');
    statusBefore = gitStatus(dir);
    const result = runCli(['improve', '--dry-run', '--max-iterations', '5', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    plan = json<PlanJson>(result);
  }, LONG);

  it('proposes isSenior(65) === true, with the value taken from the README rule, and writes no project file', () => {
    expect(plan.outcome).toBe('planned');
    expect(plan.approvalToken).toMatch(/^[0-9a-f]{64}$/);
    const names = plan.plan?.proposedTestCases.map((t) => t.name) ?? [];
    expect(names).toContain('isSenior(65) is true');
    expect(plan.plan?.patchPreview).toContain('expect(isSenior(65)).toBe(true);');
    expect(plan.plan?.patchPreview).toMatch(/^--- \/dev\/null/);
    expect(gitStatus(dir)).toBe(statusBefore);
    expect(projectStatus(dir)).toEqual([]);
  });

  it('refuses to apply without a token, with a wrong token and in CI, and writes nothing', () => {
    const attemptsDir = path.join(dir, '.veritas/improvements', plan.planId);
    const missing = runCli(['improve', '--apply', '--plan', plan.planId, '--json'], dir);
    expect(missing.status).toBe(2);
    expect(json(missing)).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const wrong = runCli(
      ['improve', '--apply', '--plan', plan.planId, '--approve', 'f'.repeat(64), '--json'],
      dir,
    );
    expect(wrong.status).toBe(2);
    expect(json(wrong)).toMatchObject({ code: 'APPROVAL_MISMATCH' });
    const ci = runCli(
      ['improve', '--apply', '--plan', plan.planId, '--approve', plan.approvalToken as string, '--json'],
      dir,
      { CI: 'true' },
    );
    expect(ci.status).toBe(2);
    expect(json(ci)).toMatchObject({ code: 'IMPROVE_APPLY_IN_CI' });
    expect(gitStatus(dir)).toBe(statusBefore);
    expect(readdirSync(attemptsDir)).toEqual(['plan.json']);
  });

  it('blocks a re-approved plan whose expected value was tampered with, leaving the repository unchanged', async () => {
    const file = path.join(dir, '.veritas/improvements', plan.planId, 'plan.json');
    const original = readFileSync(file, 'utf8');
    const hash = projectHash(dir);

    try {
      const envelope = JSON.parse(original);
      envelope.data.tests[0].expected = !envelope.data.tests[0].expected;

      for (const f of envelope.data.files) f.content = f.content.replace('toBe(true)', 'toBe(false)');
      writeFileSync(file, JSON.stringify(envelope));
      const token = approvalTokenFor(readPlan(dir, plan.planId));
      const attempt = await applyImprovement({
        root: dir,
        planId: plan.planId,
        approvalToken: token,
        env: {},
      });
      expect(attempt.outcome).toBe('blocked');
      expect(attempt.reasons.join('\n')).toMatch(/not what the specification documents/);
    } finally {
      writeFileSync(file, original);
    }
    expect(projectHash(dir)).toBe(hash);
    expect(gitStatus(dir)).toBe(statusBefore);
  });

  it(
    'rolls back completely when an added test fails in the isolated workspace',
    async () => {
      const hash = projectHash(dir);
      const attempt = await applyImprovement({
        root: dir,
        planId: plan.planId,
        approvalToken: plan.approvalToken as string,
        env: {},
        // Sabotage only the isolated copy so the added test fails there.
        afterPatchInWorkspace: (workspace) => {
          const added = path.join(workspace, plan.plan?.proposedTestCases[0]?.file as string);
          writeFileSync(added, readFileSync(added, 'utf8').replace('toBe(true)', 'toBe(false)'));
        },
      });
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.rolledBack).toBe(true);
      expect(attempt.reasons.join('\n')).toMatch(/do not all pass/);
      expect(attempt.before?.mutantsKilled).toBeGreaterThan(0);
      expect(existsSync(attempt.workspace)).toBe(false);
      expect(projectHash(dir)).toBe(hash);
      expect(gitStatus(dir)).toBe(statusBefore);
      expect(spawnSync('git', ['diff', '--quiet'], { cwd: dir }).status).toBe(0);
    },
    LONG,
  );

  it(
    'applies with the token, kills the surviving mutant and adds only the new test file',
    () => {
      const result = runCli(
        [
          'improve',
          '--apply',
          '--plan',
          plan.planId,
          '--approve',
          plan.approvalToken as string,
          '--actor',
          'Reviewer A',
          '--json',
        ],
        dir,
      );
      expect(result.status, result.stderr + result.stdout).toBe(0);
      // Who approved this exact plan, when and how is recorded; the token itself is not.
      const planDir = path.join(dir, '.veritas/improvements', plan.planId);
      const approvals = readdirSync(planDir)
        .filter((f) => f.startsWith('approval-'))
        .map((f) => JSON.parse(readFileSync(path.join(planDir, f), 'utf8')).data);
      expect(approvals).toContainEqual(
        expect.objectContaining({ planId: plan.planId, actor: 'Reviewer A', via: 'cli' }),
      );
      expect(JSON.stringify(approvals)).not.toContain(plan.approvalToken as string);
      const { attempt } = json<AttemptJson>(result);
      expect(attempt.outcome).toBe('improved');
      expect(attempt.rolledBack).toBe(false);
      expect(attempt.before && attempt.after).toBeTruthy();
      expect(attempt.after?.mutantsKilled).toBeGreaterThan(attempt.before?.mutantsKilled ?? Infinity);
      expect(attempt.after?.mutantsSurvived).toBeLessThan(attempt.before?.mutantsSurvived ?? -1);
      // Formal and property-based results are re-evaluated on the patched copy, not copied from the plan's run.
      expect(attempt.reasons.join('\n')).toMatch(/formal and property-based results re-evaluated in run-/);
      const after = attempt.after?.claimStatuses ?? {};
      expect(Object.keys(after).length).toBeGreaterThan(0);
      // The implementation did not change, so a claim made again comes out the same. Claims about the survivor
      // the new test kills (equivalence, distinguishability) are not made again: it is no longer a survivor.
      const before = attempt.before?.claimStatuses ?? {};
      const remade = Object.keys(after).filter((id) => id in before);
      expect(remade.length).toBeGreaterThan(1);
      for (const id of remade) expect(after[id], id).toBe(before[id]);
      const added = plan.plan?.proposedTestCases[0]?.file as string;
      expect(readFileSync(path.join(dir, added), 'utf8')).toContain('expect(isSenior(65)).toBe(true);');
      expect(projectStatus(dir)).toEqual([`?? ${added}`]);
      expect(spawnSync('git', ['diff', '--quiet'], { cwd: dir }).status).toBe(0);
      const attempts = readdirSync(path.join(dir, '.veritas/improvements', plan.planId)).filter((f) =>
        f.startsWith('attempt-'),
      );
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      // The same plan cannot be applied again: the project has changed since it was made.
      const again = runCli(
        ['improve', '--apply', '--plan', plan.planId, '--approve', plan.approvalToken as string, '--json'],
        dir,
      );
      expect(again.status).toBe(2);
      expect(json(again)).toMatchObject({ code: 'PLAN_STALE' });
      // The report of the run the plan was made from shows the plan and its before/after measurements.
      const report = runCli(['report', '--format', 'markdown'], dir);
      expect(report.status, report.stderr).toBe(0);
      const section = report.stdout.slice(report.stdout.indexOf('## 9. Improvement proposals'));
      expect(section).toContain(`${plan.planId} (planned)`);
      expect(section).toContain('isSenior(65) is true');
      expect(section).toMatch(/attempt [^:]+: improved; before: tests \d+ passed/);
    },
    LONG,
  );
});

describe('improve stops instead of adapting expectations', () => {
  it(
    'reports discountAmount(1000) === 100 as a spec violation candidate, never as a patch',
    () => {
      const dir = analyzed('discount-boundary');
      const status = gitStatus(dir);
      const result = runCli(['improve', '--json'], dir);
      expect(result.status, result.stderr).toBe(4);
      const plan = json<PlanJson>(result);
      expect(plan.outcome).toBe('needs_spec_decision');
      expect(plan.plan).toBeNull();
      expect(plan.approvalToken).toBeNull();
      const candidate = plan.specViolationCandidates.find((c) => c.test.input.total === '1000');
      expect(candidate?.test.expected).toBe('100');
      expect(candidate?.actual).toBe('0');
      const proposals = JSON.parse(
        readFileSync(
          path.join(dir, '.veritas/improvements', plan.planId, 'implementation-fix-proposal.json'),
          'utf8',
        ),
      ).data;
      expect(proposals[0]).toMatchObject({
        kind: 'implementation_fix_proposal',
        expectedBySpecification: '100',
        actualByImplementation: '0',
      });
      expect(gitStatus(dir)).toBe(status);
      expect(projectStatus(dir)).toEqual([]);
    },
    LONG,
  );

  it(
    'stops with needs_spec_decision and no plan on conflicting documents',
    () => {
      const dir = analyzed('conflicting-docs');
      const status = gitStatus(dir);
      const result = runCli(['improve', '--dry-run', '--json'], dir);
      expect(result.status, result.stderr).toBe(4);
      const plan = json<PlanJson>(result);
      expect(plan.outcome).toBe('needs_spec_decision');
      expect(plan.plan).toBeNull();
      expect(plan.approvalToken).toBeNull();
      expect(plan.reasons.join('\n')).toMatch(/conflict/);
      expect(plan.reasons.join('\n')).toContain('README.md:5');
      expect(gitStatus(dir)).toBe(status);
    },
    LONG,
  );
});

describe('improve without an accepted specification', () => {
  it('stops with needs_spec_decision and does not plan from a proposed property', () => {
    const dir = analyzed('agent-loop', false);
    const result = runCli(['improve', '--dry-run', '--json'], dir);
    expect(result.status).toBe(4);
    const body = JSON.parse(result.stdout) as {
      status: string;
      approvalToken: string | null;
      reasons: string[];
    };
    expect(body.status).toBe('needs_spec_decision');
    expect(body.approvalToken).toBeNull();
    expect(body.reasons.join('\n')).toMatch(/not accepted/);
    const optIn = JSON.parse(
      runCli(['improve', '--dry-run', '--include-proposed', '--json'], dir).stdout,
    ) as { status: string };
    expect(optIn.status).toBe('planned');
  }, 600_000);
});
