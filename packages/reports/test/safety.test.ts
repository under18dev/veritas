import { describe, expect, it } from 'vitest';
import {
  renderCiSummary,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderSarif,
  renderText,
  safeArtifactHref,
} from '../src/index.js';
import { fixture, reversedFixture } from './fixtures.js';

const secrets = [
  'sk-ant-1234567890',
  'ghp_123456789012345678901234567890',
  '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
];

describe('report safety and stability', () => {
  function first<T>(items: T[]): T {
    const item = items[0];

    if (item === undefined) throw new Error('expected an item');

    return item;
  }

  it('redacts token and PEM secrets from every format', () => {
    const input = fixture();
    first(input.sources).summary = secrets.join(' ');
    first(input.properties).description = first(secrets);
    first(input.findings).title = secrets[1] ?? '';

    for (const output of [
      renderText(input),
      renderMarkdown(input),
      renderHtml(input),
      renderJson(input),
      JSON.stringify(renderSarif(input)),
      renderCiSummary(input),
    ]) {
      for (const secret of secrets) expect(output).not.toContain(secret);
    }
    expect(renderText(input)).toContain('[REDACTED]');
  });

  it('escapes repository XSS payloads in HTML', () => {
    const input = fixture();
    first(input.statements).quote = '<script>alert(1)</script>';
    first(input.tests).name = '"><img src=x onerror=alert(1)>';
    first(input.properties).description = 'javascript:alert(1)';
    first(input.mutants).original = '<script>alert(1)</script>';
    first(input.sources).locator = '"><img src=x onerror=alert(1)>';
    first(input.findings).title = 'javascript:alert(1)';
    const output = renderHtml(input);
    expect(output).not.toContain('<script>alert(1)</script>');
    expect(output).not.toContain('<img src=x');
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(output).toContain('javascript:alert(1)');
  });

  it('keeps repository HTML inert in Markdown', () => {
    const input = fixture();
    first(input.statements).quote = '<script>alert(1)</script>';
    first(input.findings).title = '"><img src=x onerror=alert(1)>';
    const output = renderMarkdown(input);
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('<img');
    expect(output).toContain('&lt;script&gt;');
  });

  it('is deterministic across every renderer', () => {
    const input = fixture();
    const renderers = [
      renderText,
      renderMarkdown,
      renderHtml,
      renderJson,
      (value: typeof input) => JSON.stringify(renderSarif(value)),
      renderCiSummary,
    ];

    for (const render of renderers) expect(render(input)).toBe(render(input));
  });

  it('is invariant to input collection order across every renderer', () => {
    const original = fixture();
    const reversed = reversedFixture();
    const renderers = [
      renderText,
      renderMarkdown,
      renderHtml,
      renderJson,
      (value: typeof original) => JSON.stringify(renderSarif(value)),
      renderCiSummary,
    ];

    for (const render of renderers) expect(render(original)).toBe(render(reversed));
  });

  it('includes CI verdict, exit code, counts, URL, and a truncation note', () => {
    const output = renderCiSummary(fixture(), { artifactUrl: 'artifacts/report.md' });
    expect(output).toContain('policy_failure');
    expect(output).toContain('Exit code: 1');
    expect(output).toContain('1 confirmed, 1 suspected');
    expect(output).toContain('artifacts/report.md');
    expect(output).toContain('truncated');
    expect(output.length).toBeLessThan(65000);
  });

  it('keeps a 5,000-finding CI summary under the platform limit', () => {
    const input = fixture();
    input.findings = Array.from({ length: 5000 }, (_, index) => ({
      ...first(input.findings),
      id: `finding-${index}`,
    }));
    const output = renderCiSummary(input);
    expect(output.length).toBeLessThan(65000);
    expect(output).toContain('5,000');
  });

  it('omits the artifact link when no artifact URL is supplied', () => {
    expect(renderCiSummary(fixture())).not.toContain('Full report');
  });
});

describe('artifact links', () => {
  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,x',
    'https://evil.example',
    '//evil.example',
    '/etc',
    'C:\\runs',
  ])('never links to %s', (base) => {
    const html = renderHtml({ ...fixture(), artifactBase: base });
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] as string);

    for (const href of hrefs) {
      expect(href.startsWith('#') || !/^[a-z][a-z0-9+.-]*:|^\/|\\/i.test(href.replaceAll('&amp;', '&'))).toBe(
        true,
      );
    }
    expect(html).toContain('link omitted: unsafe location');
  });

  it.each(['../../outside.txt', 'proofs/../../../outside.txt', 'proofs/./x', '..', 'proofs/'])(
    'never links to the artifact path %s, which is not a plain path inside the run directory',
    (artifact) => {
      expect(safeArtifactHref('.veritas/runs/run-1', artifact)).toBeNull();
    },
  );

  it('keeps relative artifact links', () => {
    expect(safeArtifactHref('.', 'proofs/C-1.smt2')).toBe('./proofs/C-1.smt2');
    expect(safeArtifactHref('.veritas/runs/run-1', 'proofs/C-1.smt2')).toBe(
      '.veritas/runs/run-1/proofs/C-1.smt2',
    );
  });
});

describe('untrusted paths and links in every format', () => {
  const hostile = () => {
    const input = fixture();
    const claim = input.claims[0] as (typeof input.claims)[number];
    claim.solverInputArtifact = '../../outside.smt2';
    const finding = input.findings[0] as (typeof input.findings)[number];
    finding.locations = [{ file: 'src/discount.ts' }, { file: '../../etc/passwd' }, { file: '/etc/shadow' }];
    finding.propertyIds = [...finding.propertyIds, 'P-missing'];
    return input;
  };

  it('never prints a path outside the run directory as an artifact location', () => {
    for (const out of [renderText(hostile()), renderMarkdown(hostile())]) {
      expect(out).not.toContain('outside.smt2');
      expect(out).toContain('unsafe location omitted');
    }
  });

  it('refuses a base directory that leaves the project', () => {
    expect(safeArtifactHref('../outside', 'proof.smt2')).toBeNull();
    expect(safeArtifactHref('.veritas/runs/../../x', 'proof.smt2')).toBeNull();
  });

  it('keeps only project-relative locations in SARIF', () => {
    const sarif = renderSarif(hostile());
    expect(JSON.stringify(sarif)).not.toMatch(/passwd|shadow/);
    expect(JSON.stringify((sarif.runs[0]?.results[0] as { locations?: unknown })?.locations)).toContain(
      'src/discount.ts',
    );
  });

  it('links the CI summary only to an http(s) URL', () => {
    expect(renderCiSummary(fixture(), { artifactUrl: 'javascript:alert(1)' })).not.toContain('Full report');
    expect(renderCiSummary(fixture(), { artifactUrl: 'https://github.com/o/r/actions/runs/1' })).toContain(
      '[Full report](https://github.com/o/r/actions/runs/1)',
    );
  });

  it('renders a relation to an item missing from the report as text, not a dangling link', () => {
    const html = renderHtml(hostile());
    expect(html).not.toContain('href="#P-missing"');
    expect(html).toContain('P-missing (not in this report)');
    const anchors = new Set([...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]));
    for (const [, target] of html.matchAll(/href="#([^"]*)"/g)) expect(anchors.has(target)).toBe(true);
  });
});
