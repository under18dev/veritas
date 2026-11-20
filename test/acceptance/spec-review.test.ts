import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApprovalLedger, Property } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

interface RunJson {
  status: string;
  runId: string;
  findings: { id: string; kind: string; certainty: string; propertyIds: string[] }[];
}

function setup(name: string): string {
  const dir = copyFixture(name, { git: true, linkDeps: true });

  if (runCli(['init', '--yes'], dir).status !== 0) throw new Error('init failed');

  return dir;
}

describe('spec review commands', () => {
  it('shows, rejects with a recorded reason, diffs and exports properties, and a rejected property drives no finding', () => {
    const dir = setup('discount-boundary');
    const first = runCli(['run', '--profile', 'quick', '--json'], dir);
    expect(first.status, first.stderr).toBe(0);
    const list = json<{ properties: { id: string; origin: string; predicate?: { value: string } }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );
    const id = list.properties.find((p) => p.origin === 'normative' && p.predicate?.value === '1000')
      ?.id as string;
    expect(id).toMatch(/^P-/);

    const show = runCli(['spec', 'show', id, '--json'], dir);
    expect(show.status, show.stderr).toBe(0);
    const shown = json<{ property: unknown; approvals: unknown[] }>(show);
    const property = Property.parse(shown.property);
    expect(property).toMatchObject({ id, status: 'proposed', citations: ['README.md:7'] });
    expect(shown.approvals).toEqual([]);
    expect(runCli(['spec', 'show', 'P-000000000000', '--json'], dir).status).toBe(2);

    // A rejection without a reason is refused and records nothing.
    expect(runCli(['spec', 'reject', id, '--actor', 'reviewer'], dir).status).toBe(2);
    expect(runCli(['spec', 'reject', id, '--reason', '', '--actor', 'reviewer'], dir).status).not.toBe(0);
    expect(() => readFileSync(path.join(dir, '.veritas/approvals.json'), 'utf8')).toThrow();

    const reject = runCli(['spec', 'reject', id, '--reason', 'the README rule is outdated', '--json'], dir, {
      VERITAS_ACTOR: 'alice',
    });
    expect(reject.status, reject.stderr).toBe(0);
    expect(json<{ status: string }>(reject).status).toBe('recorded');
    const ledger = ApprovalLedger.parse(
      JSON.parse(readFileSync(path.join(dir, '.veritas/approvals.json'), 'utf8')),
    );
    expect(ledger.approvals).toHaveLength(1);
    expect(ledger.approvals[0]).toMatchObject({
      propertyId: id,
      decision: 'reject',
      actor: 'alice',
      reason: 'the README rule is outdated',
    });
    expect(
      json<{ property: { status: string }; approvals: { decision: string }[] }>(
        runCli(['spec', 'show', id, '--json'], dir),
      ),
    ).toMatchObject({ property: { status: 'rejected' }, approvals: [{ decision: 'reject' }] });

    // Even when proposed properties are verified, the rejected one produces no finding of any certainty.
    const result = runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir);
    expect(result.status, result.stderr).toBe(0);
    const run = json<RunJson>(result);
    expect(run.findings.filter((f) => f.propertyIds.includes(id))).toEqual([]);
    expect(run.status).not.toBe('policy_failure');
    expect(
      run.findings.filter(
        (f) =>
          f.certainty === 'confirmed' &&
          ['spec_implementation_mismatch', 'counterexample', 'spec_violation_candidate'].includes(f.kind),
      ),
    ).toEqual([]);
    const claims = JSON.parse(readFileSync(path.join(dir, '.veritas/runs', run.runId, 'claims.json'), 'utf8'))
      .data as { propertyId: string; kind: string }[];
    expect(claims.some((c) => c.kind === 'conformance' && c.propertyId === id)).toBe(false);

    const diff = runCli(['spec', 'diff', '--json'], dir);
    expect(diff.status, diff.stderr).toBe(0);
    const diffed = json<{
      from: string | null;
      to: string;
      diff: {
        added: unknown[];
        removed: unknown[];
        statusChanged: { id: string; from: string; to: string }[];
      };
    }>(diff);
    expect(diffed.to).toBe(run.runId);
    expect(diffed.from).toBe(json<RunJson>(first).runId);
    expect(diffed.diff.added).toEqual([]);
    expect(diffed.diff.removed).toEqual([]);
    expect(diffed.diff.statusChanged).toContainEqual({ id, from: 'proposed', to: 'rejected' });

    // export prints pure JSON even without --json, and every property is schema-valid.
    const exported = runCli(['spec', 'export'], dir);
    expect(exported.status, exported.stderr).toBe(0);
    const registry = json<{ runId: string; properties: unknown[] }>(exported);
    expect(registry.runId).toBe(run.runId);
    const properties = registry.properties.map((p) => Property.parse(p));
    expect(properties.length).toBe(list.properties.length);
    expect(properties.find((p) => p.id === id)?.status).toBe('rejected');
    expect(properties.some((p) => p.status === 'accepted')).toBe(false);
  });
});

describe('configuration that changes what a run keeps', () => {
  const configure = (dir: string, change: (config: Record<string, Record<string, unknown>>) => void) => {
    const file = path.join(dir, '.veritas/config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    change(config);
    writeFileSync(file, JSON.stringify(config));
  };
  const origins = (dir: string, runId: string) =>
    (
      JSON.parse(readFileSync(path.join(dir, '.veritas/runs', runId, 'properties.json'), 'utf8')).data as {
        properties: { origin: string }[];
      }
    ).properties.map((p) => p.origin);

  it('leaves code-inferred candidates out with analysis.inferSpecsFromCode: false', () => {
    const dir = copyFixture('discount-boundary');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    const before = json<{ runId: string }>(runCli(['analyze', '--json'], dir));
    expect(origins(dir, before.runId)).toContain('inferred');
    configure(dir, (config) => {
      config.analysis = { ...config.analysis, inferSpecsFromCode: false };
    });
    const after = json<{ runId: string }>(runCli(['analyze', '--json'], dir));
    expect(origins(dir, after.runId)).not.toContain('inferred');
    expect(origins(dir, after.runId)).toContain('normative');
  });

  it('keeps only storage.retainRuns runs', () => {
    const dir = copyFixture('discount-boundary');
    expect(runCli(['init', '--yes'], dir).status).toBe(0);
    configure(dir, (config) => {
      config.storage = { ...config.storage, retainRuns: 2 };
    });
    const ids = [1, 2, 3].map(() => json<{ runId: string }>(runCli(['discover', '--json'], dir)).runId);
    const left = readdirSync(path.join(dir, '.veritas/runs')).filter((name) => name.startsWith('run-'));
    expect(left.sort()).toEqual(ids.slice(1).sort());
  });
});

describe('decisions across commits', () => {
  it('keeps an accepted property accepted after the project is committed again', () => {
    const dir = setup('discount-boundary');
    expect(runCli(['analyze', '--json'], dir).status).toBe(0);
    const before = json<{ properties: { id: string; origin: string; predicate?: { value: string } }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );
    const id = before.properties.find((p) => p.origin === 'normative' && p.predicate?.value === '1000')
      ?.id as string;
    expect(
      runCli(['spec', 'accept', id, '--reason', 'README is authoritative', '--actor', 'reviewer'], dir)
        .status,
    ).toBe(0);
    // Committing the decision (and anything else) must not orphan it.
    writeFileSync(path.join(dir, 'CHANGES.txt'), 'unrelated change\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'decide'], {
      cwd: dir,
    });
    expect(runCli(['analyze', '--json'], dir).status).toBe(0);
    const after = json<{ properties: { id: string; status: string }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );
    expect(after.properties.find((p) => p.id === id)?.status).toBe('accepted');
    expect(runCli(['spec', 'show', id, '--json'], dir).status).toBe(0);
  });
});
