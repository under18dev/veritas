import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

function setup(name: string): string {
  const dir = copyFixture(name, { git: true, linkDeps: true });

  if (runCli(['init', '--yes'], dir).status !== 0) throw new Error('init failed');

  return dir;
}

function artifact<T>(dir: string, runId: string, file: string): T {
  return (JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, file), 'utf8')) as { data: T }).data;
}

describe('bounded equivalence of mutants', () => {
  it('proves the relu boundary mutant equivalent within the recorded domain and leaves undecidable survivors alone', () => {
    const dir = setup('equivalent-mutants');
    const run = json<{ runId: string }>(runCli(['run', '--profile', 'deep', '--json'], dir));
    const mutants = artifact<{
      mutants: {
        id: string;
        status: string;
        statusReason?: string;
        original: string;
        replacement: string;
        location: { file: string };
      }[];
    }>(dir, run.runId, 'mutation.json').mutants;
    const boundary = mutants.find((m) => m.original === 'x > 0' && m.replacement === 'x >= 0');
    expect(boundary?.status).toBe('equivalent_proven');
    expect(boundary?.statusReason).toMatch(/bounded equivalence within \{"min":"-10000","max":"10000"\}/);
    const claims = artifact<
      { kind: string; status: string; mutantId?: string; scope: { params?: { domain?: unknown }[] } }[]
    >(dir, run.runId, 'claims.json');
    const claim = claims.find((c) => c.mutantId === boundary?.id);
    expect(claim).toMatchObject({ kind: 'bounded_equivalence', status: 'proven_within_model' });
    expect(claim?.scope.params?.[0]?.domain).toEqual({ min: '-10000', max: '10000' });
    const survivorsInSmaller = mutants.filter(
      (m) => m.status === 'survived' && m.original.includes('Math.min'),
    );

    for (const m of survivorsInSmaller) expect(m.status).toBe('survived');
    expect(mutants.some((m) => m.status === 'suspected_equivalent')).toBe(false);
  });
});

describe('constructs outside the formal subset', () => {
  it('reports division, module state and NaN handling as unsupported and never as proven', () => {
    const dir = setup('unsupported-js');
    const run = json<{ runId: string }>(
      runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir),
    );
    const properties = artifact<{
      properties: { id: string; origin: string; targetSymbols: string[] }[];
      formalization: { propertyId: string; status: string; detail: string }[];
    }>(dir, run.runId, 'properties.json');
    const normative = properties.properties.filter((p) => p.origin === 'normative');
    expect(normative.length).toBe(3);

    for (const p of normative) {
      expect(properties.formalization.find((f) => f.propertyId === p.id)?.status).toBe('not_formalizable');
    }
    const claims = artifact<{ propertyId: string; status: string; semanticGaps: string[] }[]>(
      dir,
      run.runId,
      'claims.json',
    );

    for (const p of normative) {
      const claim = claims.find((c) => c.propertyId === p.id);
      expect(claim?.status).toBe('unsupported');
      expect(claim?.semanticGaps.join(' ').length).toBeGreaterThan(0);
    }
    expect(claims.some((c) => c.status === 'proven_within_model')).toBe(false);
    const report = runCli(['report', '--format', 'markdown'], dir).stdout;
    expect(report).toMatch(/unsupported/);
  });
});

describe('JavaScript numbers versus the integer model', () => {
  it('reports a rule that holds over integers but overflows safe integers as semantic_mismatch, not proven', () => {
    const dir = setup('number-model');
    runCli(['run', '--profile', 'quick', '--json'], dir);
    const list = json<{ properties: { id: string; origin: string; predicate?: { value: string } }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );
    const rule = list.properties.find((p) => p.origin === 'normative' && p.predicate?.value === '1000');
    expect(rule).toBeDefined();
    const accept = runCli(
      ['spec', 'accept', rule?.id as string, '--reason', 'README rule', '--actor', 'reviewer'],
      dir,
    );
    expect(accept.status, accept.stderr).toBe(0);

    const result = runCli(['run', '--profile', 'deep', '--json'], dir);
    const run = json<{ runId: string; status: string; reasons: string[] }>(result);
    const claims = artifact<
      {
        propertyId: string;
        kind: string;
        status: string;
        assurance: string;
        semanticGaps: string[];
        solverInputArtifact?: string;
      }[]
    >(dir, run.runId, 'claims.json');
    const claim = claims.find((c) => c.propertyId === rule?.id && c.kind === 'conformance');
    expect(claim).toMatchObject({ status: 'semantic_mismatch', assurance: 'none' });
    expect(claim?.semanticGaps.join(' ')).toMatch(/safe-integer range/);
    expect(claims.some((c) => c.propertyId === rule?.id && c.status === 'proven_within_model')).toBe(false);
    // A mismatch limits the check; it is not a violation. The default policy warns, and never reports `pass`.
    expect(result.status).toBe(0);
    expect(run.status).toBe('pass_with_warnings');
    expect(run.reasons.join(' ')).toContain('semantic_mismatch');
    expect(runCli(['report', '--format', 'markdown'], dir).stdout).toMatch(/semantic_mismatch/);

    const configPath = path.join(dir, '.veritas/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.policy.inconclusiveBehavior = 'fail';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const strict = runCli(['run', '--profile', 'deep', '--json'], dir);
    expect(strict.status).toBe(4);
    expect(json<{ status: string }>(strict).status).toBe('inconclusive');
  });
});

describe('solver time limits', () => {
  it('reports queries the solver cannot finish as timeout, keeps the mutants survived and never passes them', () => {
    const dir = setup('solver-limits');
    const configPath = path.join(dir, '.veritas/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.formal.maxSolverMs = 2000;
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = runCli(['run', '--profile', 'deep', '--json'], dir);
    const run = json<{ runId: string; status: string; reasons: string[] }>(result);
    const claims = artifact<
      { id: string; kind: string; status: string; mutantId?: string; assurance: string }[]
    >(dir, run.runId, 'claims.json');
    const timedOut = claims.filter((c) => c.status === 'timeout');
    expect(timedOut.length).toBeGreaterThan(0);

    for (const c of timedOut) expect(c.assurance).toBe('none');
    const mutants = artifact<{ mutants: { id: string; status: string }[] }>(
      dir,
      run.runId,
      'mutation.json',
    ).mutants;

    for (const c of timedOut) expect(mutants.find((m) => m.id === c.mutantId)?.status).toBe('survived');
    expect(mutants.some((m) => m.status === 'equivalent_proven')).toBe(false);
    expect(result.status).toBe(0);
    expect(run.status).toBe('pass_with_warnings');
    expect(run.reasons.join(' ')).toMatch(/=timeout/);

    config.policy.inconclusiveBehavior = 'fail';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const strict = runCli(['run', '--profile', 'deep', '--json'], dir);
    expect(strict.status).toBe(4);
    expect(json<{ status: string }>(strict).status).toBe('inconclusive');
  }, 300_000);
});
