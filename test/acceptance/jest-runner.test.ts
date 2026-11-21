import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';
import { type RunJson, readRunArtifact } from './pipeline-shared.js';

interface TestMap {
  tests: { id: string; name: string; suitePath: string[]; modifiers: string[]; suspicions: string[] }[];
}

interface Mutation {
  status: string;
  warnings: string[];
  command: string[];
  mutants: { status: string; location: { file: string }; original: string; killedBy: string[] }[];
}

describe('a Jest project (jest-app)', () => {
  it('is set up for Jest by init and checked by doctor, with mutation marked experimental', () => {
    const dir = copyFixture('jest-app', { git: true, linkDeps: true });
    const init = runCli(['init', '--yes', '--json'], dir);
    expect(init.status, init.stderr).toBe(0);
    const written = json<{
      testRunner: { name: string; reason: string; ambiguous: boolean };
      config: { analysis: { testFramework: string } };
    }>(init);
    expect(written.testRunner).toMatchObject({ name: 'jest', ambiguous: false });
    expect(written.testRunner.reason).toContain('jest.config.mjs');
    expect(
      JSON.parse(readFileSync(path.join(dir, '.veritas/config.json'), 'utf8')).analysis.testFramework,
    ).toBe('jest');

    const doctor = runCli(['doctor', '--json'], dir);
    expect(doctor.status, doctor.stderr).toBe(0);
    const report = json<{
      capabilities: { name: string; state: string; detail: string; version?: string }[];
      features: { feature: string; state: string }[];
    }>(doctor);
    const capability = (name: string) => report.capabilities.find((c) => c.name === name);
    expect(capability('jest')).toMatchObject({ state: 'available', version: '30.5.2' });
    expect(capability('vitest')).toBeUndefined();
    expect(capability('mutator')?.state).toBe('degraded');
    expect(capability('mutator')?.detail).toContain('experimental');
    expect(report.features.find((f) => f.feature === 'mutate')?.state).toBe('degraded');
  });

  it('inventories Jest tests in the quick profile without running project code', () => {
    const dir = copyFixture('jest-app', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const result = runCli(['run', '--profile', 'quick', '--offline', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    const run = json<RunJson>(result);
    expect(run.stages.map((s) => s.stage)).not.toContain('mutate');
    expect(run.stages.every((s) => s.status === 'succeeded')).toBe(true);
    const { tests } = readRunArtifact<TestMap>(dir, run.runId, 'test-map.json');
    const byName = (name: string) => tests.find((t) => t.name === name);

    // Globals, @jest/globals imports, nested describes, test.each and xit.
    expect(tests).toHaveLength(9);
    expect(byName('ships free exactly at the threshold')?.suitePath).toEqual([
      'shippingFee',
      'at the free shipping threshold',
    ]);
    expect(byName('gives no discount on small orders')?.suitePath).toEqual(['discountAmount']);
    expect(byName('shippingFee(%i) is %i')?.modifiers).toContain('each');
    expect(byName('is skipped')?.modifiers).toContain('skip');
    expect(byName('pricing works')?.suspicions).toContain('tautological_assertion');
    expect(run.findings.some((f) => f.kind === 'tautological_test')).toBe(true);
  });

  it('runs mutation with Jest in the standard profile and credits kills to the inventoried tests', () => {
    const dir = copyFixture('jest-app', { git: true, linkDeps: true });
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const result = runCli(['run', '--profile', 'standard', '--offline', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    const run = json<RunJson>(result);
    const mutate = run.stages.find((s) => s.stage === 'mutate');
    expect(mutate?.status).toBe('succeeded');
    expect(mutate?.messages.some((m) => m.startsWith('mutation testing with Jest is experimental'))).toBe(
      true,
    );
    const mutation = readRunArtifact<Mutation>(dir, run.runId, 'mutation.json');
    expect(mutation.status).toBe('succeeded');
    expect(mutation.command).toContain('--runner');
    expect(mutation.command[mutation.command.indexOf('--runner') + 1]).toBe('jest');
    // The discount boundary (`>` where the README says "or more") is not tested: its mutant survives.
    expect(
      mutation.mutants.find((m) => m.status === 'survived' && m.location.file === 'src/pricing.ts')?.original,
    ).toBe('total > 1000');
    const { tests } = readRunArtifact<TestMap>(dir, run.runId, 'test-map.json');
    const ids = new Set(tests.map((t) => t.id));
    const killers = new Set(mutation.mutants.flatMap((m) => m.killedBy));
    const boundary = tests.find((t) => t.name === 'ships free exactly at the threshold');
    expect(killers.has(boundary?.id as string)).toBe(true);
    // Names with spaces in nested suites resolve to inventoried tests; only table rows may stay unresolved.
    expect([...killers].filter((id) => ids.has(id)).length).toBeGreaterThanOrEqual(3);
    expect(run.findings.some((f) => f.kind === 'survived_mutant')).toBe(true);
  });
});
