import { describe, expect, it } from 'vitest';
import { renderHtml } from '../src/index.js';
import { fixture } from './fixtures.js';

const headings = [
  '1. Run metadata/environment/scope',
  '2. Collected evidence with provenance',
  '3. Property ledger',
  '4. Specification vs implementation mismatches',
  '5. Tests x properties matrix',
  '6. Mutation outcomes',
  '7. Formal claims',
  '8. Test assessments',
  '9. Improvement proposals',
  '10. Limitations',
];

function html(): string {
  return renderHtml(fixture());
}
function attrs(name: string): string[] {
  return [...html().matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((match) => match[1] ?? '');
}

describe('HTML report', () => {
  it('has ten ordered section headings', () => {
    const output = html();
    expect(
      headings.every((heading, index) => {
        const previous = headings[index - 1];
        return (
          output.indexOf(`<h2>${heading}</h2>`) > (previous ? output.indexOf(`<h2>${previous}</h2>`) : -1)
        );
      }),
    ).toBe(true);
  });

  it('has no dangling or duplicate anchors', () => {
    const output = html();
    const ids = attrs('id');
    const hrefs = [...output.matchAll(/href="#([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(new Set(ids).size).toBe(ids.length);
    expect(hrefs.every((href) => ids.includes(href))).toBe(true);
  });

  it('supports the complete finding drill-down chain', () => {
    const output = html();
    const finding = output.slice(
      output.indexOf('id="finding-confirmed"'),
      output.indexOf('</article>', output.indexOf('id="finding-confirmed"')),
    );
    for (const id of ['source-1', 'property-1', 'test-1', 'mutant-1', 'claim-1'])
      expect(finding).toContain(`href="#${id}"`);
    expect(output).toContain('README.md:7');
    expect(output).toContain('total &gt;= 1000');
    expect(output).toContain('.veritas/runs/run-1/solver.smt2');
  });

  it('is accessible with valid heading progression and scoped table headers', () => {
    const output = html();
    expect(output).toMatch(/<html lang="[^"]+">/);
    expect((output.match(/<h1>/g) ?? []).length).toBe(1);
    const levels = [...output.matchAll(/<h([1-6])>/g)].map((match) => Number(match[1]));
    expect(levels.every((level, index) => index === 0 || level <= (levels[index - 1] ?? level) + 1)).toBe(
      true,
    );
    expect(output).toMatch(/<th scope="col">/);
    expect(output).toContain('timeout');
  });

  it('is self-contained and has no remote resource loads', () => {
    const output = html();
    expect(output).not.toMatch(/<script\s+src|<link\b|@import|url\(http|https?:\/\//i);
  });

  it('renders status text and the empty improvement note', () => {
    expect(html()).toContain('counterexample_found');
    expect(html()).toContain('none in this run');
  });

  it('does not use standalone verification claims', () => {
    expect(html()).not.toMatch(/\bverified\b/);
    expect(html()).not.toMatch(/\bproven\b(?! within the model)/);
  });
});
