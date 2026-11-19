import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSarif } from '@veritas/reports';
import { describe, expect, it } from 'vitest';
import { copyFixture, json, runCli } from './helpers.js';

function setup(name: string): string {
  const dir = copyFixture(name, { git: true, linkDeps: true });
  if (runCli(['init', '--yes'], dir).status !== 0) throw new Error('init failed');
  return dir;
}

describe('reports from a real run', () => {
  it('writes HTML whose drill-down links all resolve and a schema-valid SARIF log', () => {
    const dir = setup('discount-boundary');
    const run = json<{ runId: string; findings: { id: string; kind: string; certainty: string }[] }>(
      runCli(['run', '--profile', 'deep', '--include-proposed', '--json'], dir),
    );
    const runDir = path.join(dir, '.veritas/runs', run.runId);
    const html = readFileSync(path.join(runDir, 'report.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((a) => !ids.has(a))).toEqual([]);
    for (const f of run.findings) expect(ids.has(f.id)).toBe(true);
    expect(html).not.toMatch(/<script\s+src|<link\s/i);
    const smtLinks = [...html.matchAll(/href="([^"#][^"]*\.smt2)"/g)].map((m) => m[1] as string);
    expect(smtLinks.length).toBeGreaterThan(0);
    for (const link of smtLinks)
      expect(readFileSync(path.join(runDir, link), 'utf8')).toContain('(check-sat)');

    const sarif = JSON.parse(readFileSync(path.join(runDir, 'report.sarif'), 'utf8'));
    expect(validateSarif(sarif)).toEqual({ valid: true, errors: [] });
    const results = sarif.runs[0].results as { level: string; properties?: { certainty?: string } }[];
    for (const r of results) if (r.properties?.certainty === 'suspected') expect(r.level).toBe('note');

    const markdown = runCli(['report', '--format', 'markdown'], dir);
    expect(markdown.status).toBe(0);
    expect(markdown.stdout).toMatch(/within the model/);
  });
});

describe('Lean backend through the CLI', () => {
  it('kernel-checks an accepted property that holds and never verifies one that fails', () => {
    const dir = setup('agent-loop');
    runCli(['run', '--profile', 'quick'], dir);
    const list = json<{ properties: { id: string; origin: string }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );
    const senior = list.properties.find((p) => p.origin === 'normative');
    expect(
      runCli(['spec', 'accept', senior?.id as string, '--reason', 'README rule', '--actor', 'reviewer'], dir)
        .status,
    ).toBe(0);
    const proved = json<{ runId: string }>(runCli(['prove', '--engine', 'lean', '--json'], dir));
    const claims = JSON.parse(
      readFileSync(path.join(dir, '.veritas/runs', proved.runId, 'claims.json'), 'utf8'),
    ).data as {
      engine: string;
      status: string;
      assurance: string;
      semanticGaps: string[];
    }[];
    expect(claims[0]).toMatchObject({
      engine: 'lean',
      status: 'proven_within_model',
      assurance: 'kernel_checked',
    });
    expect(claims[0]?.semanticGaps.join(' ')).toMatch(/TypeScript/);

    const discount = setup('discount-boundary');
    runCli(['run', '--profile', 'quick'], discount);
    const props = json<{ properties: { id: string; origin: string; predicate?: { value: string } }[] }>(
      runCli(['spec', 'list', '--json'], discount),
    );
    const rule = props.properties.find((p) => p.origin === 'normative' && p.predicate?.value === '1000');
    runCli(
      ['spec', 'accept', rule?.id as string, '--reason', 'README rule', '--actor', 'reviewer'],
      discount,
    );
    const failed = json<{ runId: string }>(
      runCli(['prove', '--engine', 'lean', '--property', rule?.id as string, '--json'], discount),
    );
    const leanClaims = JSON.parse(
      readFileSync(path.join(discount, '.veritas/runs', failed.runId, 'claims.json'), 'utf8'),
    ).data as { status: string; assurance: string }[];
    expect(leanClaims[0]?.status).not.toBe('proven_within_model');
    expect(leanClaims[0]?.assurance).toBe('none');
  });
});
