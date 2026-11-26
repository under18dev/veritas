import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';
import { type RunJson, readRunArtifact } from './pipeline-shared.js';

const LONG = 300_000;

interface TestMap {
  tests: { id: string; name: string; suitePath: string[]; modifiers: string[]; suspicions: string[] }[];
}

interface Assessment {
  testId: string;
  outcome: string;
  rationale: string[];
  limitations: string[];
}

function gitStatus(dir: string): string {
  return spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout;
}

describe('a project tested with the Node.js test runner (node-app)', () => {
  it('is set up for node --test by init, and doctor says mutation testing is unsupported and why', () => {
    const dir = copyFixture('node-app', { git: true });
    const init = runCli(['init', '--yes', '--json'], dir);
    expect(init.status, init.stderr).toBe(0);
    const written = json<{
      testRunner: { name: string; reason: string; ambiguous: boolean };
      config: { analysis: { testFramework: string; testInclude: string[] } };
    }>(init);
    expect(written.testRunner).toEqual({
      name: 'node_test',
      reason:
        'Node.js test runner is the only test runner found (the test script runs node --test, a file imports node:test)',
      ambiguous: false,
    });
    expect(
      JSON.parse(readFileSync(path.join(dir, '.veritas/config.json'), 'utf8')).analysis.testFramework,
    ).toBe('node_test');

    const doctor = runCli(['doctor', '--json'], dir);
    expect(doctor.status, doctor.stderr).toBe(0);
    const report = json<{
      capabilities: { name: string; state: string; detail: string; version?: string }[];
      features: { feature: string; state: string; missing: string[] }[];
    }>(doctor);
    const capability = (name: string) => report.capabilities.find((c) => c.name === name);
    expect(capability('node_test')).toMatchObject({
      state: 'available',
      version: process.versions.node,
      detail: `built into Node.js ${process.versions.node}`,
    });
    expect(capability('vitest')).toBeUndefined();
    expect(capability('mutator')?.state).toBe('unavailable');
    expect(capability('mutator')?.detail).toContain(
      '@mizchi/mutator cannot run tests written for the Node.js test runner',
    );
    expect(report.features.find((f) => f.feature === 'mutate')).toMatchObject({
      state: 'disabled',
      missing: ['mutator'],
    });
  });

  it('inventories node:test tests in the quick profile without running project code', () => {
    const dir = copyFixture('node-app', { git: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const result = runCli(['run', '--profile', 'quick', '--offline', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    const run = json<RunJson>(result);
    expect(run.stages.map((s) => s.stage)).not.toContain('mutate');
    expect(run.stages.every((s) => s.status === 'succeeded')).toBe(true);
    const { tests } = readRunArtifact<TestMap>(dir, run.runId, 'test-map.json');
    const byName = (name: string) => tests.find((t) => t.name === name);

    // The default import, describe/it, subtests (part of their test), .skip and a { todo } option.
    expect(tests).toHaveLength(12);
    expect(byName('ships free exactly at the threshold')?.suitePath).toEqual([
      'shippingFee',
      'at the free shipping threshold',
    ]);
    expect(byName('gives no discount on small orders')?.suitePath).toEqual([]);
    expect(byName('is checked on both sides in subtests')?.suspicions).toEqual([]);
    expect(byName('is skipped')?.modifiers).toEqual(['skip']);
    expect(byName('is not written yet')?.modifiers).toEqual(['todo']);
    expect(byName('logs the order')?.suspicions).toEqual([]);
    expect(byName('pricing works')?.suspicions).toContain('tautological_assertion');
    expect(run.findings.some((f) => f.kind === 'tautological_test')).toBe(true);
  });

  it('reports mutation as unsupported in the standard profile and judges no test meaningful without it', () => {
    const dir = copyFixture('node-app', { git: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const result = runCli(['run', '--profile', 'standard', '--offline', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    const run = json<RunJson>(result);
    // Never a success: the stage says it could not run, and why.
    const mutate = run.stages.find((s) => s.stage === 'mutate');
    expect(mutate?.status).toBe('unsupported');
    expect(mutate?.messages.join('\n')).toContain('@mizchi/mutator cannot run tests written for the Node.js');
    expect(run.status).not.toBe('pass');
    const mutation = readRunArtifact<{ status: string; mutants: unknown[] }>(dir, run.runId, 'mutation.json');
    expect(mutation).toMatchObject({ status: 'unsupported', mutants: [] });

    const { tests } = readRunArtifact<TestMap>(dir, run.runId, 'test-map.json');
    const name = new Map(tests.map((t) => [t.id, t.name]));
    const assessments = readRunArtifact<Assessment[]>(dir, run.runId, 'assessments.json');
    const outcome = (test: string) => assessments.find((a) => name.get(a.testId) === test);

    expect(assessments.some((a) => a.outcome === 'meaningful_with_evidence')).toBe(false);
    // The test of both sides of the boundary would need mutation evidence to be meaningful: it is inconclusive.
    expect(outcome('ships free exactly at the threshold')).toMatchObject({
      outcome: 'inconclusive',
      rationale: ['asserts a project result, but detection power was not measured (no mutation results)'],
    });
    expect(outcome('ships free exactly at the threshold')?.limitations).toContain(
      'no mutation results for this run; detection power not measured',
    );
    // The weak tests are weak for a reason static analysis finds without mutation.
    expect(outcome('gives a discount on large orders')?.outcome).toBe('weak_or_incomplete');
    expect(outcome('gives a discount on large orders')?.rationale[0]).toMatch(
      /^boundary not exercised: total >= 1000/,
    );
    expect(outcome('pricing works')?.outcome).toBe('tautological_or_disconnected');
  });
});

describe('improve on a node:test project (node-app)', () => {
  let dir: string;
  let plan: {
    outcome: string;
    planId: string;
    approvalToken: string | null;
    reasons: string[];
    plan: { proposedTestCases: { file: string; name: string }[]; patchPreview: string } | null;
  };
  let statusBefore: string;

  beforeAll(() => {
    dir = copyFixture('node-app', { git: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const run = runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir);
    expect([0, 1], run.stderr).toContain(run.status);
    const list = json<{ properties: { id: string; origin: string; status: string }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );

    for (const p of list.properties.filter((x) => x.origin === 'normative' && x.status === 'proposed'))
      expect(
        runCli(['spec', 'accept', p.id, '--reason', 'matches the README', '--actor', 'reviewer'], dir).status,
      ).toBe(0);
    statusBefore = gitStatus(dir);
    const result = runCli(['improve', '--dry-run', '--max-iterations', '20', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    plan = json(result);
  }, LONG);

  it('plans node:test tests with node:assert, importing the source file, and writes no project file', () => {
    expect(plan.outcome).toBe('planned');
    expect(plan.plan?.proposedTestCases.map((t) => t.name)).toEqual([
      'isWrapped(2999) is false',
      'isWrapped(3000) is true',
    ]);
    const preview = plan.plan?.patchPreview ?? '';
    expect(preview).toContain("+import assert from 'node:assert/strict';");
    expect(preview).toContain("+import { it } from 'node:test';");
    expect(preview).toContain('+import { isWrapped } from "../src/pricing.ts";');
    expect(preview).toContain('+  assert.strictEqual(isWrapped(3000), true);');
    // The discount boundary is a real violation: reported, never turned into a test.
    expect(plan.reasons.join('\n')).toContain('spec violation candidate: discountAmount(1000) returns 0');
    // The plan says up front that it cannot be applied here, and why.
    expect(plan.reasons[0]).toMatch(/^improve --apply is not available for this project: .*mutation testing/);
    expect(gitStatus(dir)).toBe(statusBefore);
  });

  it(
    'refuses to apply before running anything, since nothing could measure the added tests',
    () => {
      const attemptsDir = path.join(dir, '.veritas/improvements', plan.planId);
      const result = runCli(
        ['improve', '--apply', '--plan', plan.planId, '--approve', plan.approvalToken as string, '--json'],
        dir,
      );
      expect(result.status).toBe(2);
      const error = json<{ code: string; message: string }>(result);
      expect(error.code).toBe('IMPROVE_APPLY_UNSUPPORTED');
      expect(error.message).toContain('improve --apply is not available for this project');
      expect(error.message).toContain('@mizchi/mutator cannot run tests written for the Node.js test runner');
      // No approval recorded, no attempt, no copy made, no project file changed.
      expect(readdirSync(attemptsDir).sort()).toEqual(['implementation-fix-proposal.json', 'plan.json']);
      expect(gitStatus(dir)).toBe(statusBefore);
    },
    LONG,
  );
});
