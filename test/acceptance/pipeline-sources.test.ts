import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { json, runCli } from './helpers.js';
import { type RunJson, readRunArtifact, setup } from './pipeline-shared.js';

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

describe('test and property discriminating power', () => {
  it('shows which test inputs can tell a surviving mutant apart and which mutants each property detects', () => {
    const dir = setup('discount-boundary');
    const result = runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir);
    const { runId } = json<RunJson>(result);
    const read = (name: string) =>
      JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, name), 'utf8')).data;
    const claims = read('claims.json') as {
      id: string;
      kind: string;
      status: string;
      propertyId: string;
      mutantId?: string;
      counterexample?: Record<string, string>;
      scope: { testIds?: string[] };
    }[];
    const mutants = read('mutation.json').mutants as { id: string; status: string; replacement: string }[];
    const boundary = mutants.find((m) => m.replacement === 'total >= 1000');
    expect(boundary?.status).toBe('survived');
    // The discount tests call discountAmount(2000) and discountAmount(10): neither input can tell the mutant apart.
    const distinguish = claims.filter((c) => c.kind === 'distinguishability' && c.mutantId === boundary?.id);
    expect(distinguish.length).toBeGreaterThan(0);

    for (const c of distinguish) {
      expect(c.status).toBe('proven_within_model');
      expect(c.scope.testIds?.length).toBeGreaterThan(0);
    }
    const detection = claims.filter((c) => c.kind === 'property_detection');
    expect(detection.some((c) => c.status === 'counterexample_found')).toBe(true);
    // The README rule (total >= 1000 gives 100) is what the mutant implements: the rule cannot tell it apart.
    expect(detection.find((c) => c.mutantId === boundary?.id)?.status).toBe('proven_within_model');
    const assessments = read('assessments.json') as { testId: string; rationale: string[] }[];
    const tested = distinguish.flatMap((c) => c.scope.testIds ?? []);
    expect(
      assessments
        .filter((a) => tested.includes(a.testId))
        .some((a) =>
          a.rationale.some((r) => r.startsWith(`none of its inputs distinguishes mutant ${boundary?.id}`)),
        ),
    ).toBe(true);
  });
});
