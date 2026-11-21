import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { json, runCli } from './helpers.js';
import { type RunJson, readRunArtifact, setup } from './pipeline-shared.js';

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
});
