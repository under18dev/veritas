import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSarif } from '@under18dev/veritas-reports';
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

describe('HTML evidence chain', () => {
  it('links a confirmed mismatch to its property, README citation, tests, mutants and solver input', () => {
    const dir = setup('discount-boundary');
    runCli(['run', '--profile', 'quick'], dir);
    const list = json<{ properties: { id: string; origin: string; predicate?: { value: string } }[] }>(
      runCli(['spec', 'list', '--json'], dir),
    );
    const rule = list.properties.find((p) => p.origin === 'normative' && p.predicate?.value === '1000');
    const accept = runCli(
      ['spec', 'accept', rule?.id as string, '--reason', 'README is authoritative', '--actor', 'reviewer'],
      dir,
    );
    expect(accept.status, accept.stderr).toBe(0);
    const result = runCli(['run', '--profile', 'deep', '--json'], dir);
    expect(result.status).toBe(1);
    const run = json<{ runId: string; findings: { id: string; kind: string; certainty: string }[] }>(result);
    const finding = run.findings.find((f) => f.kind === 'spec_implementation_mismatch');
    expect(finding?.certainty).toBe('confirmed');

    const runDir = path.join(dir, '.veritas/runs', run.runId);
    const html = readFileSync(path.join(runDir, 'report.html'), 'utf8');
    // Each entity is an <article> that starts with its anchor; links are href="#<id>".
    const articles = new Map(
      [...html.matchAll(/<article><a id="([^"]+)"><\/a>([\s\S]*?)<\/article>/g)].map((m) => [
        m[1] as string,
        m[2] as string,
      ]),
    );
    const linksIn = (body: string, label: string) =>
      [...(body.match(new RegExp(`<p>${label}: (.*?)</p>`))?.[1] ?? '').matchAll(/href="#([^"]+)"/g)].map(
        (m) => m[1] as string,
      );

    // finding -> property
    const findingBody = articles.get(finding?.id as string) as string;
    expect(findingBody).toContain('confirmed');
    expect(findingBody).toContain('(README.md:7)');
    expect(linksIn(findingBody, 'Properties')).toEqual([rule?.id]);
    const propertyBody = articles.get(rule?.id as string) as string;
    expect(propertyBody).toMatch(/— accepted<\/h3>/);

    // property -> source with the quoted README line 7
    const [sourceId] = linksIn(propertyBody, 'Sources');
    expect(linksIn(findingBody, 'Sources')).toEqual([sourceId]);
    const sourceBody = articles.get(sourceId as string) as string;
    expect(sourceBody).toContain('<p>README.md:');
    expect(sourceBody).toContain(
      '<p>7: Orders with a total of 1000 or more receive a flat discount of 100.</p>',
    );

    // property -> tests -> mutants that relate back to the property
    const testIds = linksIn(propertyBody, 'Tests');
    expect(testIds.length).toBeGreaterThan(0);
    const mutantIds = new Set<string>();

    for (const t of testIds) {
      const testBody = articles.get(t) as string;
      expect(testBody).toContain('discount');

      for (const m of linksIn(testBody, 'Mutants')) mutantIds.add(m);
    }
    expect(mutantIds.size).toBeGreaterThan(0);
    const related = [...mutantIds].filter((m) =>
      linksIn(articles.get(m) as string, 'Properties').includes(rule?.id as string),
    );
    expect(related.length).toBeGreaterThan(0);
    expect(related.some((m) => /— killed<\/h3>/.test(articles.get(m) as string))).toBe(true);
    expect(
      related.some((m) => linksIn(articles.get(m) as string, 'Tests').some((t) => testIds.includes(t))),
    ).toBe(true);

    // finding -> claim -> solver input artifact that exists
    const claimIds = linksIn(findingBody, 'Claims');
    expect(claimIds.length).toBe(1);
    const claimBody = articles.get(claimIds[0] as string) as string;
    expect(claimBody).toContain('counterexample_found');
    const smt = claimBody.match(/<a href="([^"#][^"]*\.smt2)">solver input artifact<\/a>/)?.[1];
    expect(smt).toBeDefined();
    expect(readFileSync(path.join(runDir, smt as string), 'utf8')).toContain('(check-sat)');
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
