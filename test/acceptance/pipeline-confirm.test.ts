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

  it('credits no table-driven test with kills another test of its file may have made', () => {
    const dir = setup('discount-boundary');
    const write = (file: string, lines: string[]) =>
      writeFileSync(
        path.join(dir, file),
        [
          "import { describe, expect, it } from 'vitest';",
          "import { shippingFee } from '../src/pricing.js';",
          '',
        ]
          .concat(lines, '')
          .join('\n'),
      );
    // A vacuous it.each next to loop-generated tests whose titles are not literals: the loop's names fit the template.
    write('test/loop-each.test.ts', [
      "it.each([[4999]])('fee for %s', (total) => { shippingFee(total); expect(true).toBe(true); });",
      `for (const [t, f] of [[5000, 0], [4999, 500]]) it(\`fee for \${t}\`, () => { expect(shippingFee(t)).toBe(f); });`,
    ]);
    // A vacuous describe.each next to a describe whose title is not a literal.
    write('test/dynamic-describe.test.ts', [
      "describe.each([['any']])('%s', () => { it('works', () => { shippingFee(1); expect(true).toBe(true); }); });",
      `for (const y of [1]) describe(\`dyn \${y}\`, () => {`,
      "  it('works', () => { expect(shippingFee(5000)).toBe(0); expect(shippingFee(4999)).toBe(500); });",
      '});',
    ]);
    // A row title that is also the title of a plain test.
    write('test/exact-and-row.test.ts', [
      "it.each([[1]])('case %s', () => { shippingFee(1); expect(true).toBe(true); });",
      "it('case 1', () => { expect(shippingFee(5000)).toBe(0); expect(shippingFee(4999)).toBe(500); });",
    ]);
    // A vacuous it.each next to a call of an imported shared suite, which registers a test this file runs.
    write('test/shared-suite.ts', [
      'export function sharedShipping() {',
      "  it('is free at 5000', () => { expect(shippingFee(5000)).toBe(0); expect(shippingFee(4999)).toBe(500); });",
      '}',
    ]);
    write('test/probe.test.ts', [
      "import { sharedShipping } from './shared-suite.js';",
      "it.each([{ name: 'small order', total: 10 }])('$name', ({ total }) => { shippingFee(total); expect(true).toBe(true); });",
      'sharedShipping();',
    ]);
    // The same shared suite called in other shapes.
    for (const [file, call] of [
      ['test/probe-assigned.test.ts', 'const registered = sharedShipping();'],
      ['test/probe-foreach.test.ts', '[sharedShipping].forEach((f) => f());'],
    ] as const)
      write(file, [
        "import { sharedShipping } from './shared-suite.js';",
        "it.each([{ name: 'small order', total: 10 }])('$name', ({ total }) => { shippingFee(total); expect(true).toBe(true); });",
        call,
      ]);
    // A shared suite that registers through an alias of `it`, which the inventory does not read as a registration.
    write('test/shared-suite-alias.ts', [
      'export function sharedShipping() {',
      '  const register = it;',
      "  register('is free at 5000', () => { expect(shippingFee(5000)).toBe(0); expect(shippingFee(4999)).toBe(500); });",
      '}',
    ]);
    write('test/probe-alias.test.ts', [
      "import { sharedShipping } from './shared-suite-alias.js';",
      "it.each([{ name: 'small order', total: 10 }])('$name', ({ total }) => { shippingFee(total); expect(true).toBe(true); });",
      'sharedShipping();',
    ]);
    // A broad it.each next to a plain test in a describe: the template cannot take the plain test's two titles.
    write('test/broad-each.test.ts', [
      "it.each([{ name: 'small order', total: 10 }])('$name', ({ total }) => { shippingFee(total); expect(true).toBe(true); });",
      "describe('threshold', () => {",
      "  it('is free at 5000', () => { expect(shippingFee(5000)).toBe(0); expect(shippingFee(4999)).toBe(500); });",
      '});',
    ]);
    const run = json<RunJson>(runCli(['mutate', '--kill-matrix', '--json'], dir));
    const stage = run.stages.find((s) => s.stage === 'mutate');
    expect(stage?.status).toBe('succeeded');
    const tests = readRunArtifact<{
      tests: { id: string; file: string; name: string; suitePath: string[] }[];
    }>(dir, run.runId, 'test-map.json').tests;
    const killers = new Set(
      readRunArtifact<{ mutants: { killedBy: string[] }[] }>(dir, run.runId, 'mutation.json').mutants.flatMap(
        (m) => m.killedBy,
      ),
    );
    const id = (file: string, name: string, suitePath: string[] = []) =>
      tests.find(
        (t) => t.file === file && t.name === name && t.suitePath.join(' > ') === suitePath.join(' > '),
      )?.id as string;

    expect(killers.has(id('test/loop-each.test.ts', 'fee for %s'))).toBe(false);
    expect(killers.has(id('test/dynamic-describe.test.ts', 'works', ['%s']))).toBe(false);
    expect(killers.has(id('test/exact-and-row.test.ts', 'case %s'))).toBe(false);
    expect(killers.has(id('test/exact-and-row.test.ts', 'case 1'))).toBe(false);
    expect(killers.has(id('test/probe.test.ts', '$name'))).toBe(false);
    expect(killers.has(id('test/probe-assigned.test.ts', '$name'))).toBe(false);
    expect(killers.has(id('test/probe-foreach.test.ts', '$name'))).toBe(false);
    expect(killers.has(id('test/probe-alias.test.ts', '$name'))).toBe(false);
    expect(killers.has(id('test/broad-each.test.ts', '$name'))).toBe(false);
    expect(killers.has(id('test/broad-each.test.ts', 'is free at 5000', ['threshold']))).toBe(true);
    const messages = stage?.messages.join('\n') ?? '';
    // mutator numbers the second test of a run with the same full name: `fee for 4999#2`, `case 1#2`.
    expect(messages).toMatch(
      /could not read the full name of every test \(a test title that is not a literal\)[^\n]*test\/loop-each\.test\.ts#fee for 4999, test\/loop-each\.test\.ts#fee for 4999#2/,
    );
    expect(messages).toMatch(
      /\(a describe title that is not a literal\)[^\n]*test\/dynamic-describe\.test\.ts#dyn 1 > works/,
    );
    expect(messages).toMatch(
      /\(code at the top level or in a describe callback that may register tests, such as a call of a shared suite\)[^\n]*test\/probe-alias\.test\.ts#is free at 5000[^\n]*test\/probe-assigned\.test\.ts#is free at 5000[^\n]*test\/probe-foreach\.test\.ts#is free at 5000/,
    );
    expect(messages).toMatch(
      /are the title of one test and also match the title of a table-driven test[^\n]*test\/exact-and-row\.test\.ts#case 1, test\/exact-and-row\.test\.ts#case 1#2/,
    );
  });
});
