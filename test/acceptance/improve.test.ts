import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyImprovement,
  approvalTokenFor,
  projectHash,
  readPlan,
} from '../../packages/improvement/dist/index.js';
import { CLI, copyFixture, json, REPO_ROOT, runCli } from './helpers.js';

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
    const result = runCli(['improve', '--dry-run', '--max-iterations', '20', '--json'], dir);
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
      // The rewrite of the added file is reported as well.
      expect(attempt.reasons.join('\n')).toContain(
        `changed the isolated copy beyond the plan's files (${plan.plan?.proposedTestCases[0]?.file})`,
      );
      expect(attempt.before?.mutantsKilled).toBeGreaterThan(0);
      expect(existsSync(attempt.workspace)).toBe(false);
      expect(projectHash(dir)).toBe(hash);
      expect(gitStatus(dir)).toBe(statusBefore);
      expect(spawnSync('git', ['diff', '--quiet'], { cwd: dir }).status).toBe(0);
    },
    LONG,
  );

  type Hook = (workspace: string) => void | Promise<void>;

  /**
   * Apply the plan with a hook acting in the copy as a test could (after the patch unless `when` says otherwise), and
   * check the repository is unchanged.
   */
  async function applyTampered(hook: Hook, when: 'baseline' | 'patch' | 'patched-runs' = 'patch') {
    const hash = projectHash(dir);
    const status = gitStatus(dir);
    const attempt = await applyImprovement({
      root: dir,
      planId: plan.planId,
      approvalToken: plan.approvalToken as string,
      env: {},
      ...(when === 'baseline' ? { afterBaselineInWorkspace: hook } : {}),
      ...(when === 'patch' ? { afterPatchInWorkspace: hook } : {}),
      ...(when === 'patched-runs' ? { afterPatchedRunsInWorkspace: hook } : {}),
    });
    expect(attempt.rolledBack).toBe(when !== 'baseline');
    expect(existsSync(attempt.workspace)).toBe(false);
    expect(projectHash(dir)).toBe(hash);
    expect(gitStatus(dir)).toBe(status);

    return attempt;
  }

  it(
    'discards the patch when the patched run rewrites a copied source file',
    async () => {
      let inspector: string | undefined = 'not checked';
      const attempt = await applyTampered(async (workspace) => {
        appendFileSync(path.join(workspace, 'src/age.ts'), '// rewritten\n');
        // Code under test may signal the Veritas process to open its inspector; during an apply it stays closed.
        if (process.platform !== 'win32') {
          process.kill(process.pid, 'SIGUSR1');
          await new Promise((r) => setTimeout(r, 300));
          inspector = (await import('node:inspector')).url();
        }
      });
      if (process.platform !== 'win32') expect(inspector).toBeUndefined();
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.reasons[0]).toContain("changed the isolated copy beyond the plan's files (src/age.ts)");
    },
    LONG,
  );

  it(
    'discards the patch when the patched run rewrites an existing test',
    async () => {
      const attempt = await applyTampered((workspace) => {
        appendFileSync(path.join(workspace, 'test/age.test.ts'), '// rewritten\n');
      });
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.reasons[0]).toContain("beyond the plan's files (test/age.test.ts)");
    },
    LONG,
  );

  it(
    'discards the patch when the added test file is rewritten, even with its content and time restored',
    async () => {
      const added = plan.plan?.proposedTestCases[0]?.file as string;
      const attempt = await applyTampered((workspace) => {
        const file = path.join(workspace, added);
        const content = readFileSync(file);
        const { atime, mtime } = statSync(file);
        writeFileSync(file, '');
        writeFileSync(file, content);
        utimesSync(file, atime, mtime);
      });
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.reasons[0]).toContain(`beyond the plan's files (${added})`);
    },
    LONG,
  );

  it(
    'discards the measurement when the baseline runs change the copy',
    async () => {
      const attempt = await applyTampered((workspace) => {
        appendFileSync(path.join(workspace, 'src/age.ts'), '// rewritten\n');
      }, 'baseline');
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.reasons[0]).toContain(
        'the baseline runs changed files of the isolated copy (src/age.ts)',
      );
    },
    LONG,
  );

  it(
    'discards the patch when the copy changes during the patched mutation run or the re-evaluation',
    async () => {
      const attempt = await applyTampered((workspace) => {
        appendFileSync(path.join(workspace, 'test/age.test.ts'), '// rewritten\n');
      }, 'patched-runs');
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.reasons[0]).toContain("beyond the plan's files (test/age.test.ts)");
    },
    LONG,
  );

  it(
    "discards the patch when a package link of the copy's node_modules is replaced",
    async () => {
      // Re-created to the same place, so the runs still work; a fake package in its place would forge them.
      const attempt = await applyTampered((workspace) => {
        const link = path.join(workspace, 'node_modules/vitest');
        const target = realpathSync(link);
        unlinkSync(link);
        symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      });
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.reasons[0]).toContain("beyond the plan's files (node_modules/vitest)");
    },
    LONG,
  );

  it(
    'starts each mutation run in the copy without mutator state a test left there',
    async () => {
      const hash = projectHash(dir);
      let plantedSurvived: boolean | null = null;
      const attempt = await applyImprovement({
        root: dir,
        planId: plan.planId,
        approvalToken: plan.approvalToken as string,
        env: {},
        // Forged resume state: mutator adopts stored verdicts from it without running the tests.
        afterPatchInWorkspace: (workspace) => {
          mkdirSync(path.join(workspace, '.mutator/scopes'), { recursive: true });
          writeFileSync(path.join(workspace, '.mutator/scopes/snapshot.json.resume.sqlite'), 'forged');
          writeFileSync(path.join(workspace, '.mutator/planted'), '');
        },
        afterPatchedRunsInWorkspace: (workspace) => {
          plantedSurvived = existsSync(path.join(workspace, '.mutator/planted'));
          // Stop here, so the plan stays applicable for the next test.
          appendFileSync(path.join(workspace, 'src/age.ts'), '// stop\n');
        },
      });
      // The patched mutation run and the re-evaluation completed, from a removed .mutator.
      expect(plantedSurvived).toBe(false);
      expect(attempt.outcome).toBe('no_safe_improvement');
      expect(attempt.reasons[0]).toContain("beyond the plan's files (src/age.ts)");
      expect(projectHash(dir)).toBe(hash);
    },
    LONG,
  );

  /** Run `fn` with a package installed outside the project and linked into it like a pnpm store entry. */
  async function withLinkedDependency(fn: (pkg: string) => Promise<void>) {
    const pkg = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-dep-'))), 'tamper-target');
    mkdirSync(pkg);
    writeFileSync(path.join(pkg, 'index.js'), 'export const value = 1;\n');
    const link = path.join(dir, 'node_modules/tamper-target');
    symlinkSync(pkg, link, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      await fn(pkg);
    } finally {
      unlinkSync(link);
      rmSync(path.dirname(pkg), { recursive: true, force: true });
    }
  }

  const writeDependency = (workspace: string) =>
    writeFileSync(path.join(workspace, 'node_modules/tamper-target/index.js'), 'export const value = 2;\n');

  it(
    'reports an error and writes nothing when the patched run writes into a linked dependency',
    () =>
      withLinkedDependency(async (pkg) => {
        const attempt = await applyTampered(writeDependency);
        expect(attempt.outcome).toBe('error');
        expect(attempt.reasons[0]).toMatch(/changed 1 path\(s\) of the dependencies/);
        expect(attempt.reasons[0]).toContain(path.join(pkg, 'index.js'));
        // A package linked from outside node_modules: its files are restored, not reinstalled.
        expect(attempt.reasons[0]).toMatch(/cannot undo this: restore the files of the linked packages/);
        expect(attempt.reasons).toContain('nothing was written to the repository');
      }),
    LONG,
  );

  it(
    'reports a dependency write first when the attempt stops early for another reason',
    () =>
      withLinkedDependency(async (pkg) => {
        const added = plan.plan?.proposedTestCases[0]?.file as string;
        const attempt = await applyTampered((workspace) => {
          writeDependency(workspace);
          // The added test now fails, which ends the attempt before the patched mutation run.
          const file = path.join(workspace, added);
          writeFileSync(file, readFileSync(file, 'utf8').replace('toBe(true)', 'toBe(false)'));
        });
        expect(attempt.outcome).toBe('error');
        expect(attempt.reasons[0]).toContain(path.join(pkg, 'index.js'));
        expect(attempt.reasons.join('\n')).toMatch(/do not all pass/);
      }),
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

// On Windows, ending a process from outside (child.kill, taskkill) terminates it without running any handler, so
// nothing can remove the copy then; the next apply's sweep of stale copies does (see the improve guide).
describe.skipIf(process.platform === 'win32')('improve ended by a signal', () => {
  it(
    'removes a copy when the process is ended while the copy is being made',
    async () => {
      // A project large enough that copying it takes a while, and a process that only makes a copy and waits.
      const project = mkdtempSync(path.join(tmpdir(), 'veritas-sigterm-project-'));
      for (let i = 0; i < 2000; i++) {
        mkdirSync(path.join(project, `d${i % 40}`), { recursive: true });
        writeFileSync(path.join(project, `d${i % 40}`, `f${i}.ts`), 'x'.repeat(1000));
      }
      const script = path.join(project, '..', `${path.basename(project)}-child.mjs`);
      writeFileSync(
        script,
        `const { createWorkspace } = await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'packages/improvement/dist/index.js')).href)});\ncreateWorkspace(process.argv[2]);\nsetInterval(() => {}, 1000);\n`,
      );
      const parent = path.join(homedir(), '.cache');
      mkdirSync(parent, { recursive: true });
      const cache = mkdtempSync(path.join(parent, 'veritas-acceptance-'));
      const base = path.join(cache, 'veritas/improve');

      try {
        // Ended as soon as the copy directory exists, that is during the copy, several times.
        for (let round = 0; round < 5; round++) {
          const child = spawn(process.execPath, [script, project], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CACHE_HOME: cache },
            stdio: 'ignore',
          });
          const exited = once(child, 'exit');
          const deadline = Date.now() + 30_000;
          while (
            !(existsSync(base) && readdirSync(base).some((n) => /^veritas-improve-\w{6}$/.test(n))) &&
            child.exitCode === null &&
            Date.now() < deadline
          )
            await new Promise((r) => setTimeout(r, 1));
          child.kill('SIGTERM');
          await exited;
          expect(readdirSync(base)).toEqual([]);
        }
      } finally {
        rmSync(cache, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
        rmSync(script, { force: true });
      }
    },
    LONG,
  );

  it(
    'removes the copy when an apply is ended by SIGTERM, and changes nothing in the project',
    async () => {
      // A project and plan of its own: whatever the ended apply leaves cannot affect other tests.
      const dir = analyzed('agent-loop');
      const planned = runCli(['improve', '--dry-run', '--json'], dir);
      expect(planned.status, planned.stderr).toBe(0);
      const plan = json<PlanJson>(planned);
      const hash = projectHash(dir);
      // A cache directory of its own, under the real one so its parents are safe.
      const parent = path.join(homedir(), '.cache');
      mkdirSync(parent, { recursive: true });
      const cache = mkdtempSync(path.join(parent, 'veritas-acceptance-'));
      const base = path.join(cache, 'veritas/improve');
      const copies = () =>
        existsSync(base) ? readdirSync(base).filter((n) => /^veritas-improve-\w{6}$/.test(n)) : [];
      const child = spawn(
        process.execPath,
        [
          CLI,
          'improve',
          '--apply',
          '--plan',
          plan.planId,
          '--approve',
          plan.approvalToken as string,
          '--json',
        ],
        {
          cwd: dir,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CACHE_HOME: cache },
          stdio: 'ignore',
        },
      );
      const exited = once(child, 'exit');

      try {
        const deadline = Date.now() + 60_000;
        while (copies().length === 0 && child.exitCode === null && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
        expect(copies()).toHaveLength(1);
        child.kill('SIGTERM');
        await exited;
        expect(readdirSync(base)).toEqual([]);
        expect(projectHash(dir)).toBe(hash);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
        rmSync(cache, { recursive: true, force: true });
      }
    },
    LONG,
  );
});
