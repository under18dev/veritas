import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, REPO_ROOT, runCli } from './helpers.js';

interface Claim {
  propertyId: string;
  kind: string;
  engine: string;
  status: string;
  assurance: string;
  semanticValidation: string;
  semanticGaps: string[];
  counterexample?: Record<string, unknown>;
}

interface Summary {
  runId: string;
  stages: { stage: string; status: string; messages: string[] }[];
  findings: { kind: string; certainty: string; propertyIds: string[] }[];
}

const GUARDED = 'D-stage.guarded-succeeded-needs-tests';
const UNGUARDED = 'D-stage.unguarded-succeeded-needs-tests';
const CHECK = path.join(REPO_ROOT, 'scripts/check-self-verification.mjs');

function read<T>(dir: string, runId: string, name: string): T {
  return JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, name), 'utf8')).data as T;
}

function editConfig(dir: string, edit: (config: { properties: Record<string, unknown>[] }) => void): void {
  const file = path.join(dir, '.veritas/config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  edit(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
}

function check(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [CHECK, '--root', dir, ...args], { encoding: 'utf8' });
}

describe('declared properties', () => {
  it('proves an accepted declaration with Z3 and Lean and refutes the negative control with a replayed counterexample', () => {
    const dir = copyFixture('declared-properties');
    const prove = runCli(['prove', '--engine', 'both', '--json'], dir);
    // The negative control is accepted and refuted: a confirmed violation.
    expect(prove.status, prove.stderr).toBe(1);
    const summary = json<Summary>(prove);
    const claims = read<Claim[]>(dir, summary.runId, 'claims.json').filter((c) => c.kind === 'conformance');
    const of = (id: string, engine: string) =>
      claims.filter(
        (c) => c.propertyId === id && (engine === 'lean' ? c.engine === 'lean' : c.engine.startsWith('z3')),
      );

    expect(of(GUARDED, 'z3')).toMatchObject([
      { status: 'proven_within_model', semanticValidation: 'confirmed' },
    ]);
    expect(of(GUARDED, 'lean')).toMatchObject([
      { status: 'proven_within_model', assurance: 'kernel_checked' },
    ]);
    expect(of(UNGUARDED, 'z3')).toMatchObject([
      {
        status: 'counterexample_found',
        semanticValidation: 'confirmed',
        counterexample: { e: { testsRan: expect.stringMatching(/^(0|-\d+)$/), failed: false } },
      },
    ]);
    // Lean is never asked to prove what Z3 refuted.
    expect(of(UNGUARDED, 'lean')).toEqual([]);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        kind: 'spec_implementation_mismatch',
        certainty: 'confirmed',
        propertyIds: [UNGUARDED],
      }),
    );
    const properties = read<{ properties: { id: string; origin: string; status: string }[] }>(
      dir,
      summary.runId,
      'properties.json',
    ).properties;
    expect(properties.map((p) => [p.id, p.origin, p.status])).toEqual([
      [GUARDED, 'human', 'accepted'],
      [UNGUARDED, 'human', 'accepted'],
    ]);

    // The check script passes only with the negative control named as such.
    const passed = check(dir, '--expect-counterexample', 'stage.unguarded-succeeded-needs-tests');
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
    expect(passed.stdout).toContain(`ok   ${GUARDED}`);
    const failed = check(dir);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain(`FAIL ${UNGUARDED}: expected proven by Z3 and kernel-checked by Lean`);
  }, 600_000);

  it('verifies nothing that is not accepted, names it, and stops trusting an approval when the declaration changes', () => {
    const dir = copyFixture('declared-properties');
    rmSync(path.join(dir, '.veritas/approvals.json'));
    const proposed = runCli(['prove', '--engine', 'z3', '--json'], dir);
    expect(proposed.status, proposed.stderr).toBe(0);
    const summary = json<Summary>(proposed);
    expect(read<Claim[]>(dir, summary.runId, 'claims.json')).toEqual([]);
    const messages = summary.stages.find((s) => s.stage === 'prove')?.messages ?? [];
    expect(messages).toContainEqual(
      expect.stringContaining(`${GUARDED}: declared property not verified, it is proposed`),
    );
    expect(messages).toContainEqual(expect.stringContaining(`veritas spec accept ${UNGUARDED} --reason`));
    expect(check(dir, '--expect-counterexample', 'stage.unguarded-succeeded-needs-tests').stdout).toContain(
      `FAIL ${GUARDED}: proposed, not accepted`,
    );

    // A changed declaration keeps its id, gets a new version, and the old approval no longer applies.
    const changed = copyFixture('declared-properties');
    editConfig(changed, (config) => {
      (config.properties[0] as { domain?: unknown }).domain = { integer: { min: '0', max: '100' } };
    });
    const rerun = runCli(['prove', '--engine', 'z3', '--json'], changed);
    const properties = read<{ properties: { id: string; status: string }[]; staleApprovals: string[] }>(
      changed,
      json<Summary>(rerun).runId,
      'properties.json',
    );
    expect(properties.properties.find((p) => p.id === GUARDED)?.status).toBe('proposed');
    expect(properties.properties.find((p) => p.id === UNGUARDED)?.status).toBe('accepted');
    expect(properties.staleApprovals).toHaveLength(1);
    // The prove stage names the stale approval and that the property is not verified.
    const rerunMessages = json<Summary>(rerun).stages.find((s) => s.stage === 'prove')?.messages ?? [];
    expect(rerunMessages).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${GUARDED.replaceAll('.', '\\.')}: the accept recorded by fixture \\(A-\\w+\\) was for version \\d+ of the declaration; it is now version \\d+`,
        ),
      ),
    );
    expect(rerunMessages).toContainEqual(
      expect.stringContaining(`${GUARDED}: declared property not verified, it is proposed`),
    );
  }, 600_000);

  it('reports a declaration it cannot check as unsupported, with the reason, never dropping it', () => {
    const dir = copyFixture('declared-properties');
    const declare = (id: string, target: string) => ({
      id,
      kind: 'holds_for_all',
      target,
      description: `cannot be checked: ${id}`,
    });
    editConfig(dir, (config) => {
      config.properties.push(
        declare('number', 'src/stage.ts#statusCode'),
        declare('loops', 'src/stage.ts#invariant_loops'),
        declare('hidden', 'src/stage.ts#invariant_hidden'),
        declare('missing-file', 'src/missing.ts#invariant'),
        declare('missing-export', 'src/stage.ts#invariant_nowhere'),
      );
    });
    const ids = ['number', 'loops', 'hidden', 'missing-file', 'missing-export'].map((id) => `D-${id}`);
    const prove = runCli(
      ['prove', '--engine', 'z3', '--include-proposed', '--json', ...ids.flatMap((id) => ['--property', id])],
      dir,
    );
    // inconclusiveBehavior: fail
    expect(prove.status, prove.stderr).toBe(4);
    const claims = read<Claim[]>(dir, json<Summary>(prove).runId, 'claims.json');
    const reason = (id: string) => {
      const own = claims.filter((c) => c.propertyId === id);
      expect(own, id).toHaveLength(1);
      expect(own[0]?.status, id).toBe('unsupported');

      return own[0]?.semanticGaps.join(' ');
    };
    expect(reason('D-number')).toMatch(/returns a number/);
    expect(reason('D-loops')).toMatch(/outside the supported subset/);
    expect(reason('D-hidden')).toMatch(/exports no function named invariant_hidden/);
    expect(reason('D-missing-file')).toMatch(/target file src\/missing\.ts does not exist/);
    expect(reason('D-missing-export')).toMatch(/exports no function named invariant_nowhere/);
  }, 600_000);

  it('rejects an invalid declaration as a configuration error', () => {
    const dir = copyFixture('declared-properties');
    editConfig(dir, (config) => {
      config.properties.push({ ...config.properties[0] });
    });
    const prove = runCli(['prove', '--json'], dir);
    expect(prove.status).toBe(2);
    expect(prove.stdout + prove.stderr).toMatch(/duplicate property id stage\.guarded-succeeded-needs-tests/);
  });
});

describe('check-self-verification', () => {
  type CheckRun = (input: {
    declared: string[];
    expectCounterexample: string[];
    properties: { id: string; status: string }[];
    claims: Partial<Claim>[];
    stages: { stage: string; status: string }[];
  }) => { ok: boolean; lines: string[] };
  const load = async () => ((await import(pathToFileURL(CHECK).href)) as { checkRun: CheckRun }).checkRun;
  const z3 = (status: string, semanticValidation = 'confirmed') => ({
    propertyId: 'D-a',
    kind: 'conformance',
    engine: 'z3-wasm',
    status,
    assurance: status === 'proven_within_model' ? 'smt_bounded' : 'none',
    semanticValidation,
  });
  const lean = {
    propertyId: 'D-a',
    kind: 'conformance',
    engine: 'lean',
    status: 'proven_within_model',
    assurance: 'kernel_checked',
    semanticValidation: 'not_attempted',
  };
  const input = (claims: Partial<Claim>[], extra: Partial<Parameters<CheckRun>[0]> = {}) => ({
    declared: ['a'],
    expectCounterexample: [],
    properties: [{ id: 'D-a', status: 'accepted' }],
    claims,
    stages: [{ stage: 'prove', status: 'succeeded' }],
    ...extra,
  });

  it('passes only a property proven by Z3 with replay and kernel-checked by Lean', async () => {
    const checkRun = await load();
    expect(checkRun(input([z3('proven_within_model'), lean])).ok).toBe(true);
    const failing: [string, Parameters<CheckRun>[0]][] = [
      ['no Lean claim', input([z3('proven_within_model')])],
      ['no claim', input([])],
      ['Z3 replay not confirmed', input([z3('proven_within_model', 'not_attempted'), lean])],
      ['Lean without kernel check', input([z3('proven_within_model'), { ...lean, assurance: 'none' }])],
      ...['unknown', 'timeout', 'unsupported', 'semantic_mismatch', 'error', 'counterexample_found'].map(
        (status): [string, Parameters<CheckRun>[0]] => [status, input([z3(status), lean])],
      ),
      [
        'an unsupported claim besides the proofs',
        input([z3('proven_within_model'), lean, { ...z3('unsupported'), engine: 'none' }]),
      ],
      [
        'not accepted',
        input([z3('proven_within_model'), lean], { properties: [{ id: 'D-a', status: 'proposed' }] }),
      ],
      ['missing from the run', input([z3('proven_within_model'), lean], { properties: [] })],
      [
        'the prove stage did not succeed',
        input([z3('proven_within_model'), lean], { stages: [{ stage: 'prove', status: 'partial' }] }),
      ],
      ['no prove stage', input([z3('proven_within_model'), lean], { stages: [] })],
      [
        'an unknown negative control',
        input([z3('proven_within_model'), lean], { expectCounterexample: ['b'] }),
      ],
    ];

    for (const [name, data] of failing) expect(checkRun(data).ok, name).toBe(false);
  });

  it('passes a negative control only with a counterexample reproduced in JavaScript and no proof', async () => {
    const checkRun = await load();
    const control = (claims: Partial<Claim>[]) => checkRun(input(claims, { expectCounterexample: ['a'] })).ok;
    expect(control([z3('counterexample_found')])).toBe(true);
    expect(control([z3('counterexample_found', 'mismatch')])).toBe(false);
    expect(control([z3('semantic_mismatch', 'mismatch')])).toBe(false);
    expect(control([z3('proven_within_model'), lean])).toBe(false);
    expect(control([z3('unknown')])).toBe(false);
    expect(control([z3('counterexample_found'), lean])).toBe(false);
  });

  it('fails on usage errors and on a project without declarations', () => {
    expect(check(REPO_ROOT, '--bogus', 'x').status).toBe(2);
    expect(check(REPO_ROOT, '--run').status).toBe(2);
    const dir = copyFixture('declared-properties');
    editConfig(dir, (config) => {
      config.properties = [];
    });
    const result = check(dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/declares no property/);
    expect(check(copyFixture('declared-properties')).stderr).toMatch(/no run with claims/);
  });
});
