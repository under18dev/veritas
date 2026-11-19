import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderText } from '../src/index.js';
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

describe('text and markdown reports', () => {
  it('contains all ten text sections in order', () => {
    const output = renderText(fixture());
    expect(
      headings.every((heading, index) => {
        const previous = headings[index - 1];
        return output.indexOf(heading) > (previous ? output.indexOf(previous) : -1);
      }),
    ).toBe(true);
  });

  it('contains all ten markdown headings in order', () => {
    const output = renderMarkdown(fixture());
    expect(
      headings.every((heading, index) => {
        const previous = headings[index - 1];
        return output.indexOf(`## ${heading}`) > (previous ? output.indexOf(`## ${previous}`) : -1);
      }),
    ).toBe(true);
  });

  it('renders the empty improvement section explicitly', () => {
    expect(renderText(fixture())).toContain('9. Improvement proposals\nnone in this run');
  });

  it('lists incomplete stages, claim limitations, and inferred properties', () => {
    const output = renderMarkdown(fixture());
    expect(output).toContain('stage prove was timeout');
    expect(output).toContain('claim claim-3 is unsupported');
    expect(output).toContain('claim claim-4 is semantic_mismatch');
    expect(output).toContain('claim claim-5 is timeout');
    expect(output).toContain('claim claim-6 is unknown');
    expect(output).toContain('property property-2 is inferred (not a specification)');
  });

  it('renders finding id, certainty, and severity in text', () => {
    expect(renderText(fixture())).toContain('finding-confirmed [confirmed, high]');
    expect(renderText(fixture())).toContain('confirmed');
    expect(renderText(fixture())).toContain('high');
  });

  it('scopes proven claims and inferred properties in text and markdown', () => {
    for (const output of [renderText(fixture()), renderMarkdown(fixture())]) {
      expect(output).toContain('proven within the model');
      expect(output).toContain('domain "[0, 2000]"');
      expect(output).toContain('inferred (not a specification)');
      expect(output).not.toMatch(/\bverified\b/);
      expect(output).not.toMatch(/\bproven\b(?! within the model)/);
    }
  });
});
