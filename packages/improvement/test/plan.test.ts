import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyImprovement, approvalTokenFor, planImprovement, projectHash, readPlan } from '../src/index.js';
import {
  AGE_SOURCE,
  assertingTest,
  DISCOUNT_SOURCE,
  equivalenceClaim,
  project,
  type RunInput,
  survivedMutant,
  thresholdPropertyOf,
  writeRun,
} from './helpers.js';

const README = '# t\n\nVisitors aged 65 or older are seniors.\n';

function seniorProperty(overrides = {}) {
  return thresholdPropertyOf({
    file: 'src/age.ts',
    source: AGE_SOURCE,
    exportName: 'isSenior',
    param: 'age',
    operator: '>=',
    value: '65',
    whenTrue: true,
    whenFalse: false,
    overrides,
  });
}

function seniorProject(overrides = {}, extra: Partial<RunInput> = {}) {
  const root = project({
    'src/age.ts': AGE_SOURCE,
    'README.md': README,
    'test/age.test.ts': '// existing\n',
  });
  const p = seniorProperty(overrides);
  const m = survivedMutant('src/age.ts', 'age >= 65', 'age > 65', p.id);
  writeRun(root, {
    properties: [p],
    mutants: [m],
    claims: [equivalenceClaim(p.id, m.id, { age: '65' })],
    tests: [assertingTest('test/age.test.ts', 'src/age.ts#isSenior', '80')],
    ...extra,
  });
  return { root, property: p, mutant: m };
}

function filesUnder(root: string, dir: string): string[] {
  const abs = path.join(root, dir);
  return existsSync(abs) ? readdirSync(abs, { recursive: true }).map(String).sort() : [];
}

describe('planImprovement', () => {
  it('proposes a test for the distinguishing input with the value the specification documents', async () => {
    const { root, property, mutant } = seniorProject();
    const before = projectHash(root);
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('planned');
    expect(result.approvalToken).toMatch(/^[0-9a-f]{64}$/);
    const doc = readPlan(root, result.planId);
    const fromMutant = doc.tests.find((t) => t.mutantId === mutant.id);
    expect(fromMutant).toMatchObject({ input: { age: '65' }, expected: true, propertyId: property.id });
    // 64 is the other side of the boundary; 80 is already covered by an asserting test.
    expect(doc.tests.map((t) => t.input.age).sort()).toEqual(['64', '65']);
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0]?.path).toBe(`test/veritas-${property.id}.test.ts`);
    expect(doc.files[0]?.content).toContain('expect(isSenior(65)).toBe(true);');
    expect(result.plan?.patchPreview).toContain(`+++ b/test/veritas-${property.id}.test.ts`);
    expect(result.plan?.touchesProductionCode).toBe(false);
    expect(result.plan?.risks.join()).toMatch(/not accepted/);
    // The dry run writes only under .veritas/improvements.
    expect(projectHash(root)).toBe(before);
    expect(existsSync(path.join(root, doc.files[0]?.path ?? 'x'))).toBe(false);
  });

  it('gives the same plan the same token', async () => {
    const { root } = seniorProject();
    const a = await planImprovement({ root });
    const b = await planImprovement({ root });
    expect(b.planId).toBe(a.planId);
    expect(b.approvalToken).toBe(a.approvalToken);
  });

  it('stops with needs_spec_decision and no plan when a targeted property is conflicted', async () => {
    const { root, property } = seniorProject({ status: 'conflicted', conflictsWith: ['P-other'] });
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('needs_spec_decision');
    expect(result.plan).toBeNull();
    expect(result.approvalToken).toBeNull();
    expect(result.reasons.join('\n')).toContain(property.id);
    expect(result.reasons.join('\n')).toMatch(/conflict/);
  });

  it('stops when the target symbol has a conflict group, even if the property itself is not marked', async () => {
    const root = project({ 'src/age.ts': AGE_SOURCE });
    const p = seniorProperty();
    writeRun(root, {
      properties: [p],
      conflicts: [
        {
          id: 'CF-1',
          symbol: 'src/age.ts#isSenior',
          param: 'age',
          propertyIds: ['P-a', 'P-b'],
          preferredPropertyId: null,
          rationale: ['README.md:5 vs issue #1'],
        },
      ],
    });
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('needs_spec_decision');
    expect(result.reasons.join('\n')).toContain('CF-1');
  });

  it('turns a test the implementation fails into a spec violation candidate, never into a patch', async () => {
    const root = project({ 'src/pricing.ts': DISCOUNT_SOURCE });
    const p = thresholdPropertyOf({
      file: 'src/pricing.ts',
      source: DISCOUNT_SOURCE,
      exportName: 'discountAmount',
      param: 'total',
      operator: '>=',
      value: '1000',
      whenTrue: '100',
      whenFalse: '0',
      assumptions: ['assumed: discountAmount returns 0 when the condition does not hold'],
    });
    const m = survivedMutant('src/pricing.ts', 'total > 1000', 'total >= 1000', p.id);
    writeRun(root, {
      properties: [p],
      mutants: [m],
      claims: [equivalenceClaim(p.id, m.id, { total: '1000' })],
    });
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('needs_spec_decision');
    expect(result.plan).toBeNull();
    expect(result.specViolationCandidates).toHaveLength(1);
    const candidate = result.specViolationCandidates[0];
    expect(candidate?.test).toMatchObject({ input: { total: '1000' }, expected: '100' });
    expect(candidate?.actual).toBe('0');
    expect(result.implementationFixProposals[0]).toMatchObject({
      kind: 'implementation_fix_proposal',
      expectedBySpecification: '100',
      actualByImplementation: '0',
    });
    const proposalFile = path.join(
      root,
      '.veritas/improvements',
      result.planId,
      'implementation-fix-proposal.json',
    );
    expect(JSON.parse(readFileSync(proposalFile, 'utf8')).data[0].expectedBySpecification).toBe('100');
    // 999 relies on an assumed value (not stated by the source), so it is not proposed either.
    expect(result.skipped.find((s) => s.input?.total === '999')?.reason).toMatch(/assumption/);
    expect(filesUnder(root, 'test')).toEqual([]);
  });

  it('keeps passing tests in the plan next to spec violation candidates', async () => {
    const root = project({ 'src/pricing.ts': DISCOUNT_SOURCE });
    const p = thresholdPropertyOf({
      file: 'src/pricing.ts',
      source: DISCOUNT_SOURCE,
      exportName: 'discountAmount',
      param: 'total',
      operator: '>=',
      value: '1000',
      whenTrue: '100',
      whenFalse: '0',
    });
    writeRun(root, { properties: [p] });
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('planned');
    const doc = readPlan(root, result.planId);
    expect(doc.tests.map((t) => [t.input.total, t.expected])).toEqual([['999', '0']]);
    expect(result.specViolationCandidates.map((c) => c.test.input.total)).toEqual(['1000']);
    expect(doc.files[0]?.content).not.toContain('1000');
  });

  it('does not take expected values from properties inferred from the implementation', async () => {
    const { root } = seniorProject({ origin: 'inferred' });
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('no_safe_improvement');
    expect(result.skipped.map((s) => s.reason).join()).toMatch(/inferred/);
  });

  it('ignores properties whose sources are all stale', async () => {
    const { root } = seniorProject({}, { staleStatements: ['stmt-1'] });
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('no_safe_improvement');
    expect(result.skipped.map((s) => s.reason).join()).toMatch(/stale/);
  });

  it('skips survived mutants without a distinguishing input', async () => {
    const root = project({ 'src/age.ts': AGE_SOURCE });
    const p = seniorProperty();
    const m = survivedMutant('src/age.ts', 'age >= 65', 'age > 65', p.id);
    writeRun(root, {
      properties: [p],
      mutants: [m],
      claims: [
        { ...equivalenceClaim(p.id, m.id, {}), status: 'proven_within_model', counterexample: undefined },
      ],
      tests: ['64', '65'].map((v) => assertingTest('test/a.test.ts', 'src/age.ts#isSenior', v)),
    });
    const result = await planImprovement({ root });
    expect(result.outcome).toBe('no_safe_improvement');
    expect(result.skipped.find((s) => s.mutantId === m.id)?.reason).toMatch(/proven_within_model/);
  });

  it('records the budgets from the configuration and options', async () => {
    const { root } = seniorProject();
    const result = await planImprovement({ root, maxIterations: 2 });
    expect(result.plan?.budget).toMatchObject({ maxIterations: 2, maxPatchFiles: 5, maxTestRetries: 1 });
    await expect(planImprovement({ root, maxIterations: 0 })).rejects.toThrow(/max iterations/);
  });
});

describe('applyImprovement refusals', () => {
  async function planned() {
    const ctx = seniorProject();
    const result = await planImprovement({ root: ctx.root });
    return { ...ctx, result, hash: projectHash(ctx.root) };
  }

  it('refuses a missing or wrong token and writes nothing', async () => {
    const { root, result, hash } = await planned();
    const env = {};
    await expect(
      applyImprovement({ root, planId: result.planId, approvalToken: '', env }),
    ).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await expect(
      applyImprovement({ root, planId: result.planId, approvalToken: 'f'.repeat(64), env }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH', exitCode: 2 });
    expect(projectHash(root)).toBe(hash);
    expect(filesUnder(root, `.veritas/improvements/${result.planId}`)).toEqual(['plan.json']);
  });

  it('refuses in CI even with the right token', async () => {
    const { root, result, hash } = await planned();
    await expect(
      applyImprovement({
        root,
        planId: result.planId,
        approvalToken: result.approvalToken ?? '',
        env: { CI: 'true' },
      }),
    ).rejects.toMatchObject({ code: 'IMPROVE_APPLY_IN_CI', exitCode: 2 });
    expect(projectHash(root)).toBe(hash);
  });

  it('refuses a plan id that is not a plan id', async () => {
    const { root } = await planned();
    await expect(
      applyImprovement({ root, planId: '../../etc', approvalToken: 'x', env: {} }),
    ).rejects.toMatchObject({
      code: 'PLAN_ID_INVALID',
    });
  });

  it('refuses a plan made for an older version of the project', async () => {
    const { root, result } = await planned();
    writeFileSync(path.join(root, 'src/age.ts'), AGE_SOURCE.replace('65', '66'));
    await expect(
      applyImprovement({ root, planId: result.planId, approvalToken: result.approvalToken ?? '', env: {} }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
  });

  it('blocks a re-approved plan whose expected value was changed away from the specification', async () => {
    const { root, result, hash } = await planned();
    const file = path.join(root, '.veritas/improvements', result.planId, 'plan.json');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    envelope.data.tests[0].expected = !envelope.data.tests[0].expected;
    writeFileSync(file, JSON.stringify(envelope));
    const token = approvalTokenFor(readPlan(root, result.planId));
    const attempt = await applyImprovement({ root, planId: result.planId, approvalToken: token, env: {} });
    expect(attempt.outcome).toBe('blocked');
    expect(attempt.reasons.join('\n')).toMatch(/not what the specification documents/);
    expect(projectHash(root)).toBe(hash);
  });

  it.each([
    [
      'a production file',
      (d: { files: { path: string }[] }) => ((d.files[0] as { path: string }).path = 'src/age.ts'),
    ],
    ['a README', (d: { files: { path: string }[] }) => ((d.files[0] as { path: string }).path = 'README.md')],
    [
      'a path outside the project',
      (d: { files: { path: string }[] }) => ((d.files[0] as { path: string }).path = '../x.test.ts'),
    ],
    [
      'an edited assertion',
      (d: { files: { content: string }[] }) => {
        const f = d.files[0] as { content: string };
        f.content = f.content.replace('toBe(true)', 'toBeDefined()');
      },
    ],
    [
      'a deletion',
      (d: { files: { operation: string }[] }) => {
        (d.files[0] as { operation: string }).operation = 'delete';
      },
    ],
  ])('blocks a re-approved plan that touches %s', async (_name, tamper) => {
    const { root, result, hash } = await planned();
    const file = path.join(root, '.veritas/improvements', result.planId, 'plan.json');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    tamper(envelope.data);
    writeFileSync(file, JSON.stringify(envelope));
    const token = approvalTokenFor(readPlan(root, result.planId));
    const attempt = await applyImprovement({ root, planId: result.planId, approvalToken: token, env: {} });
    expect(attempt.outcome).toBe('blocked');
    expect(attempt.rolledBack).toBe(false);
    expect(projectHash(root)).toBe(hash);
    expect(readFileSync(path.join(root, 'src/age.ts'), 'utf8')).toBe(AGE_SOURCE);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(README);
  });

  it('reports a tool failure without touching the repository and stops at the iteration budget', async () => {
    // No node_modules: the baseline test run cannot start, which is an error, not a success.
    const { root } = seniorProject();
    const result = await planImprovement({ root, maxIterations: 1 });
    const hash = projectHash(root);
    const token = result.approvalToken ?? '';
    const first = await applyImprovement({ root, planId: result.planId, approvalToken: token, env: {} });
    expect(first.outcome).toBe('error');
    expect(first.reasons.join()).toMatch(/vitest is not installed/);
    expect(first.before).toBeNull();
    expect(existsSync(first.workspace)).toBe(false);
    const second = await applyImprovement({ root, planId: result.planId, approvalToken: token, env: {} });
    expect(second.outcome).toBe('blocked');
    expect(second.reasons.join()).toMatch(/iteration budget exhausted/);
    expect(projectHash(root)).toBe(hash);
    expect(filesUnder(root, `.veritas/improvements/${result.planId}`)).toEqual([
      'attempt-1.json',
      'attempt-2.json',
      'plan.json',
    ]);
  });

  it('refuses to apply a plan that has nothing to apply', async () => {
    const { root } = seniorProject({ status: 'conflicted' });
    const result = await planImprovement({ root });
    const token = approvalTokenFor(readPlan(root, result.planId));
    await expect(
      applyImprovement({ root, planId: result.planId, approvalToken: token, env: {} }),
    ).rejects.toMatchObject({
      code: 'PLAN_NOT_APPLICABLE',
    });
  });
});
