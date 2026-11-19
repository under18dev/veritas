import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

interface RunJson {
  status: string;
  exitCode: number;
  runId: string;
  stages: { stage: string; status: string; messages: string[] }[];
  findings: {
    id: string;
    kind: string;
    certainty: string;
    propertyIds: string[];
    mutantIds: string[];
    claimIds: string[];
  }[];
}

function readRunArtifact<T>(dir: string, runId: string, file: string): T {
  return (JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, file), 'utf8')) as { data: T }).data;
}

function setup(name: string): string {
  const dir = copyFixture(name, { git: true, linkDeps: true });
  const init = runCli(['init', '--yes'], dir);
  if (init.status !== 0) throw new Error(init.stderr);
  return dir;
}

describe('discount-boundary end to end', () => {
  it('finds the boundary mismatch, the weak tests and the tautological test without accepting anything', () => {
    const dir = setup('discount-boundary');
    const result = runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    const run = json<RunJson>(result);
    expect(run.status).toBe('pass_with_warnings');
    expect(run.stages.every((s) => s.status === 'succeeded')).toBe(true);

    const properties = readRunArtifact<{
      properties: {
        id: string;
        status: string;
        origin: string;
        predicate?: { value: string };
        citations: string[];
      }[];
    }>(dir, run.runId, 'properties.json').properties;
    expect(properties.some((p) => p.status === 'accepted')).toBe(false);
    const discount = properties.find((p) => p.origin === 'normative' && p.predicate?.value === '1000');
    expect(discount?.citations).toEqual(['README.md:7']);

    const mismatch = run.findings.find((f) => f.kind === 'spec_implementation_mismatch');
    expect(mismatch?.certainty).toBe('suspected');
    expect(mismatch?.propertyIds).toEqual([discount?.id]);

    const claims = readRunArtifact<
      {
        id: string;
        kind: string;
        status: string;
        counterexample?: Record<string, string>;
        semanticValidation: string;
        solverInputArtifact?: string;
        assumptions: string[];
        scope: { params?: { domain?: unknown }[] };
      }[]
    >(dir, run.runId, 'claims.json');
    const conformance = claims.find((c) => c.kind === 'conformance' && c.counterexample);
    expect(conformance).toMatchObject({
      status: 'counterexample_found',
      counterexample: { total: '1000' },
      semanticValidation: 'confirmed',
    });
    const smt = readFileSync(
      path.join(dir, '.veritas/runs', run.runId, conformance?.solverInputArtifact as string),
      'utf8',
    );
    expect(smt).toContain('(check-sat)');
    const proven = claims.find((c) => c.kind === 'conformance' && c.status === 'proven_within_model');
    expect(proven).toBeDefined();
    // An unsat result keeps its solver input, the bounded domain and the assumptions it depends on.
    expect(
      readFileSync(path.join(dir, '.veritas/runs', run.runId, proven?.solverInputArtifact as string), 'utf8'),
    ).toContain('(check-sat)');
    expect(proven?.scope.params?.[0]?.domain).toEqual({ min: '-10000', max: '10000' });
    expect(proven?.assumptions.join(' ')).toMatch(/restricted to the stated domains/);
    expect(run.findings.some((f) => f.kind === 'spec_conflict')).toBe(false);

    const tests = readRunArtifact<{ tests: { id: string; name: string }[] }>(
      dir,
      run.runId,
      'test-map.json',
    ).tests;
    const assessments = readRunArtifact<{ testId: string; outcome: string; rationale: string[] }[]>(
      dir,
      run.runId,
      'assessments.json',
    );
    const outcome = (name: string) =>
      assessments.find((a) => a.testId === tests.find((t) => t.name === name)?.id)?.outcome;
    expect(outcome('pricing works')).toBe('tautological_or_disconnected');
    expect(outcome('gives a discount on large orders')).toBe('weak_or_incomplete');
    expect(outcome('ships free exactly at the threshold')).toBe('meaningful_with_evidence');
    expect(outcome('charges shipping just below the threshold')).toBe('meaningful_with_evidence');
  });

  it('relates killed and survived mutants to the property and never calls the survivor equivalent', () => {
    const dir = setup('discount-boundary');
    const run = json<RunJson>(runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir));
    const mutants = readRunArtifact<{
      mutants: {
        id: string;
        status: string;
        relevance: string;
        original: string;
        replacement: string;
        killedBy: string[];
        propertyIds: string[];
      }[];
    }>(dir, run.runId, 'mutation.json').mutants;
    const survivor = mutants.find((m) => m.original === 'total > 1000' && m.replacement === 'total >= 1000');
    expect(survivor?.status).toBe('survived');
    expect(survivor?.relevance).toBe('spec_relevant');
    const killedShipping = mutants.filter((m) => m.status === 'killed' && m.original === 'total >= 5000');
    expect(killedShipping.length).toBeGreaterThan(0);
    for (const m of killedShipping) {
      expect(m.killedBy.length).toBeGreaterThan(0);
      expect(m.propertyIds.length).toBeGreaterThan(0);
    }
    const gap = run.findings.find((f) => f.kind === 'survived_mutant');
    expect(gap?.mutantIds).toEqual([survivor?.id]);
    const claims = readRunArtifact<
      { mutantId?: string; kind: string; status: string; counterexample?: Record<string, string> }[]
    >(dir, run.runId, 'claims.json');
    expect(claims.find((c) => c.mutantId === survivor?.id)).toMatchObject({
      kind: 'bounded_equivalence',
      status: 'counterexample_found',
      counterexample: { total: '1000' },
    });
  });

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

  it('finds the counterexample with a recorded seed and generates a runnable property test', () => {
    const dir = setup('discount-boundary');
    const run = json<RunJson>(runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir));
    const pbt = readRunArtifact<
      {
        propertyId: string;
        status: string;
        trust: string;
        seed: number;
        counterexample: Record<string, string> | null;
      }[]
    >(dir, run.runId, 'pbt.json');
    const failing = pbt.find((r) => r.status === 'counterexample');
    expect(failing).toMatchObject({ trust: 'falsified', counterexample: { total: '1000' } });
    const passing = pbt.find((r) => r.status === 'passed');
    expect(passing?.trust).toBe('empirically_supported');
    const again = json<RunJson>(runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir));
    const repeat = readRunArtifact<
      { propertyId: string; seed: number; counterexample: Record<string, string> | null }[]
    >(dir, again.runId, 'pbt.json');
    expect(repeat.find((r) => r.propertyId === failing?.propertyId)).toMatchObject({
      seed: failing?.seed,
      counterexample: failing?.counterexample,
    });

    const gen = runCli(['test', 'generate', '--json'], dir);
    expect(gen.status, gen.stderr).toBe(0);
    const generated = json<{ generated: { file: string; propertyId: string }[] }>(gen).generated;
    expect(generated.length).toBeGreaterThan(0);
    for (const g of generated) expect(g.file.startsWith('.veritas/generated-tests/')).toBe(true);
    const vitest = spawnSync(
      process.execPath,
      [path.join(dir, 'node_modules/vitest/vitest.mjs'), 'run', '.veritas/generated-tests'],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
    expect(vitest.status).not.toBe(0);
    expect(vitest.stdout + vitest.stderr).toMatch(/Counterexample: \[\{"total":1000\}\]/);
  });

  it('replays a run with the same stages and records a new run', () => {
    const dir = setup('discount-boundary');
    const first = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const replay = json<RunJson>(runCli(['replay', first.runId, '--json'], dir));
    expect(replay.runId).not.toBe(first.runId);
    expect(replay.stages.map((s) => s.stage)).toEqual(first.stages.map((s) => s.stage));
    expect(replay.findings.map((f) => f.id).sort()).toEqual(first.findings.map((f) => f.id).sort());
  });

  it('replays the run with the command shown in the rendered markdown report', () => {
    const dir = setup('discount-boundary');
    const first = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const rendered = runCli(['report', '--format', 'markdown'], dir);
    expect(rendered.status, rendered.stderr).toBe(0);
    const command = /`(veritas replay [^`]+)`/.exec(rendered.stdout)?.[1];
    expect(command).toBe(`veritas replay ${first.runId}`);
    // The report written by the run shows the same command.
    expect(readFileSync(path.join(dir, '.veritas/runs', first.runId, 'report.md'), 'utf8')).toContain(
      `\`${command}\``,
    );
    const [program, ...args] = (command as string).split(' ');
    expect(program).toBe('veritas');
    const replay = json<RunJson>(runCli([...args, '--json'], dir));
    expect(replay.runId).not.toBe(first.runId);
    expect(replay.stages.map((s) => s.stage)).toEqual(first.stages.map((s) => s.stage));
    expect(replay.findings.map((f) => f.id).sort()).toEqual(first.findings.map((f) => f.id).sort());
    expect(first.findings.length).toBeGreaterThan(0);
  });
});

describe('a ten-function project', () => {
  it('finds exactly the two boundary mismatches and no false counterexample', () => {
    const dir = setup('small-app');
    const run = json<RunJson>(runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir));
    const mismatches = run.findings.filter((f) => f.kind === 'spec_implementation_mismatch');
    const claims = readRunArtifact<
      { kind: string; status: string; propertyId: string; counterexample?: Record<string, string> }[]
    >(dir, run.runId, 'claims.json').filter((c) => c.kind === 'conformance');
    const counterexamples = claims
      .filter((c) => c.status === 'counterexample_found')
      .map((c) => c.counterexample)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(counterexamples).toEqual([{ distance: '50' }, { points: '300' }]);
    expect(mismatches).toHaveLength(2);
    // Rules the extractor cannot read are reported (unsupported or not formalized), never guessed.
    for (const c of claims)
      expect(['proven_within_model', 'counterexample_found', 'unsupported']).toContain(c.status);
    expect(claims.filter((c) => c.status === 'proven_within_model').length).toBeGreaterThanOrEqual(5);
  });
});

describe('specification sources', () => {
  it('keeps code-only specifications inferred and unaccepted', () => {
    const dir = setup('no-spec');
    const run = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const { properties } = readRunArtifact<{ properties: { origin: string; status: string }[] }>(
      dir,
      run.runId,
      'properties.json',
    );
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.every((p) => p.origin === 'inferred' && p.status === 'proposed')).toBe(true);
    expect(
      run.findings.some((f) => f.certainty === 'confirmed' && f.kind === 'spec_implementation_mismatch'),
    ).toBe(false);
  });

  it('reports README and Issue as conflicting with both sources and a suggested reading', () => {
    const dir = setup('conflicting-docs');
    const run = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const data = readRunArtifact<{
      properties: { id: string; status: string; citations: string[] }[];
      conflicts: { propertyIds: string[]; preferredPropertyId: string | null; rationale: string[] }[];
    }>(dir, run.runId, 'properties.json');
    expect(data.conflicts).toHaveLength(1);
    const conflict = data.conflicts[0];
    const conflicted = data.properties.filter((p) => conflict?.propertyIds.includes(p.id));
    expect(conflicted.every((p) => p.status === 'conflicted')).toBe(true);
    const citations = conflicted.flatMap((p) => p.citations).join(' ');
    expect(citations).toMatch(/README\.md:5/);
    expect(citations).toMatch(/issues\/42/);
    expect(conflict?.preferredPropertyId).not.toBeNull();
    expect(data.properties.some((p) => p.status === 'accepted')).toBe(false);
    expect(run.findings.some((f) => f.kind === 'spec_conflict')).toBe(true);
  });

  it('runs a degraded local analysis without network or LLM key and invents nothing', () => {
    const dir = setup('discount-boundary');
    const run = json<RunJson>(
      runCli(['run', '--profile', 'quick', '--offline', '--json'], dir, { ANTHROPIC_API_KEY: '' }),
    );
    const evidence = readRunArtifact<{ networkRequests: number }>(dir, run.runId, 'evidence.json');
    expect(evidence.networkRequests).toBe(0);
    const runJson = readRunArtifact<{ capabilities: { name: string; state: string }[] }>(
      dir,
      run.runId,
      'run.json',
    );
    expect(runJson.capabilities.find((c) => c.name === 'llm')?.state).toBe('disabled');
    expect(existsSync(path.join(dir, '.veritas/runs', run.runId, 'claims.json'))).toBe(false);
  });

  it('treats instructions inside documentation as data', () => {
    const dir = setup('security');
    const before = readFileSync(path.join(dir, '.veritas/config.json'), 'utf8');
    const run = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    expect(readFileSync(path.join(dir, '.veritas/config.json'), 'utf8')).toBe(before);
    expect(existsSync(path.join(dir, '..', 'outside.txt'))).toBe(false);
    const { properties } = readRunArtifact<{ properties: { status: string }[] }>(
      dir,
      run.runId,
      'properties.json',
    );
    expect(properties.some((p) => p.status === 'accepted')).toBe(false);
    const evidence = readRunArtifact<{
      networkRequests: number;
      sources: { id: string; locator: string }[];
      statements: { sourceId: string; quote: string; modality: string; flags: string[] }[];
    }>(dir, run.runId, 'evidence.json');
    expect(evidence.networkRequests).toBe(0);
    expect(evidence.statements.some((s) => s.flags.includes('instruction_like'))).toBe(true);
    // Ordinary normative statements next to the injected text are specification evidence, not instructions.
    const ordinary = evidence.statements.filter((s) => /at least 0|limited to the range/.test(s.quote));
    expect(ordinary.map((s) => s.quote).sort()).toEqual([
      'The clamp function must return a value of at least 0.',
      '`clamp(x)` returns x limited to the range 0 to 10, inclusive.',
    ]);
    for (const s of ordinary) expect(s.flags).not.toContain('instruction_like');
    expect(ordinary.find((s) => /must return/.test(s.quote))?.modality).toBe('must');
  });

  it('does not flag the ordinary rules of a README as instruction-like', () => {
    const dir = setup('discount-boundary');
    const run = json<RunJson>(runCli(['run', '--profile', 'quick', '--json'], dir));
    const evidence = readRunArtifact<{
      sources: { id: string; locator: string }[];
      statements: { sourceId: string; quote: string; range: { start: number }; flags: string[] }[];
    }>(dir, run.runId, 'evidence.json');
    const readme = evidence.sources.find((s) => s.locator === 'README.md');
    const statements = evidence.statements.filter((s) => s.sourceId === readme?.id);
    expect(statements.map((s) => s.range.start).sort((a, b) => a - b)).toEqual([7, 11, 11]);
    expect(statements.filter((s) => s.flags.includes('instruction_like'))).toEqual([]);
    expect(evidence.statements.some((s) => s.flags.includes('instruction_like'))).toBe(false);
  });
});
