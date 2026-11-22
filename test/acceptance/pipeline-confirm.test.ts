import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { json, runCli } from './helpers.js';
import { type RunJson, readRunArtifact, setup } from './pipeline-shared.js';

describe('discount-boundary end to end: confirmation and cache', () => {
  it('makes the violation confirmed only after a human accepts the property, and explains the chain', () => {
    const dir = setup('discount-boundary');
    const first = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const list = json<{ properties: { id: string; origin: string; predicate?: { value: string } }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );
    const discount = list.properties.find((p) => p.origin === 'normative' && p.predicate?.value === '1000');
    expect(first.findings.find((f) => f.kind === 'spec_implementation_mismatch')?.certainty).toBe(
      'suspected',
    );

    expect(runCli(['spec', 'accept', discount?.id as string], dir).status).toBe(2); // --reason is required
    const accept = runCli(
      [
        'spec',
        'accept',
        discount?.id as string,
        '--reason',
        'README is authoritative',
        '--actor',
        'reviewer',
        '--json',
      ],
      dir,
    );
    expect(accept.status, accept.stderr).toBe(0);
    const ledger = JSON.parse(readFileSync(path.join(dir, '.veritas/approvals.json'), 'utf8'));
    expect(ledger.approvals[0]).toMatchObject({
      propertyId: discount?.id,
      actor: 'reviewer',
      reason: 'README is authoritative',
      decision: 'accept',
    });

    const result = runCli(['run', '--profile', 'deep', '--json'], dir);
    expect(result.status).toBe(1);
    const run = json<RunJson>(result);
    expect(run.status).toBe('policy_failure');
    const finding = run.findings.find((f) => f.kind === 'spec_implementation_mismatch');
    expect(finding?.certainty).toBe('confirmed');

    const explain = json<{
      statements: { quote: string; range: { start: number } }[];
      claims: { solverInputArtifact?: string }[];
      properties: { status: string }[];
    }>(runCli(['explain', finding?.id as string, '--json'], dir));
    expect(explain.statements[0]).toMatchObject({ range: { start: 7 } });
    expect(explain.statements[0]?.quote).toMatch(/1000 or more/);
    expect(explain.properties[0]?.status).toBe('accepted');
    const smtPath = explain.claims.find((c) => c.solverInputArtifact)?.solverInputArtifact as string;
    expect(existsSync(path.join(dir, '.veritas/runs', run.runId, smtPath))).toBe(true);
  });

  it('reuses mutation results from the cache until a test file changes', () => {
    const dir = setup('discount-boundary');
    const standard = () => json<RunJson>(runCli(['run', '--profile', 'standard', '--json'], dir));
    const mutate = (run: RunJson) => run.stages.find((s) => s.stage === 'mutate');
    const statuses = (run: RunJson) =>
      readRunArtifact<{ mutants: { id: string; status: string }[] }>(dir, run.runId, 'mutation.json')
        .mutants.map((m) => [m.id, m.status])
        .sort();
    const first = standard();
    expect(mutate(first)?.status).toBe('succeeded');
    expect(mutate(first)?.messages.join(' ')).not.toMatch(/reused from cache/);
    const second = standard();
    expect(mutate(second)?.messages.join(' ')).toMatch(/mutation results reused from cache [0-9a-f]{64}/);
    expect(statuses(second)).toEqual(statuses(first));
    expect(statuses(first).length).toBeGreaterThan(0);

    const test = path.join(dir, 'test/discount-weak.test.ts');
    writeFileSync(test, `${readFileSync(test, 'utf8')}\n// edited\n`);
    const third = standard();
    expect(mutate(third)?.status).toBe('succeeded');
    expect(mutate(third)?.messages.join(' ')).not.toMatch(/reused from cache/);
  });
});

describe('table-driven tests end to end', () => {
  it('credits kills by the rows of it.each and describe.each to the tests that register them', () => {
    const dir = setup('discount-boundary');
    writeFileSync(
      path.join(dir, 'test/shipping-each.test.ts'),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { shippingFee } from '../src/pricing.js';",
        '',
        'it.each`',
        '  total   | fee',
        `  \${4999} | \${500}`,
        `  \${5000} | \${0}`,
        "`('ships an order of $total for $fee', ({ total, fee }) => {",
        '  expect(shippingFee(total)).toBe(fee);',
        '});',
        '',
        "describe.each([['below', 4999, 500], ['at', 5000, 0]])('an order %s the threshold', (_where, total, fee) => {",
        "  it('costs %s to ship', () => {",
        '    expect(shippingFee(total as number)).toBe(fee);',
        '  });',
        '});',
        '',
      ].join('\n'),
    );
    const run = json<RunJson>(runCli(['mutate', '--kill-matrix', '--json'], dir));
    expect(run.stages.find((s) => s.stage === 'mutate')?.status).toBe('succeeded');
    const tests = readRunArtifact<{ tests: { id: string; file: string; name: string }[] }>(
      dir,
      run.runId,
      'test-map.json',
    ).tests.filter((t) => t.file === 'test/shipping-each.test.ts');
    const killers = new Set(
      readRunArtifact<{ mutants: { killedBy: string[] }[] }>(dir, run.runId, 'mutation.json').mutants.flatMap(
        (m) => m.killedBy,
      ),
    );

    expect(tests.map((t) => t.name).sort()).toEqual([
      'costs %s to ship',
      'ships an order of $total for $fee',
    ]);
    for (const test of tests) expect(killers.has(test.id), test.name).toBe(true);
  });
});
