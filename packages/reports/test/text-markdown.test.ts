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
    expect(renderText(fixture())).toContain('9. Improvement proposals\nnone for this run');
  });

  it('lists improvement plans of the run with their before and after measurements', () => {
    const input = fixture();
    input.improvements = [
      {
        planId: 'IP-0123456789ab',
        outcome: 'improved',
        goal: 'kill the boundary mutant of discountAmount',
        proposedTests: ['test/pricing.test.ts: total of exactly 1000 gets the discount'],
        patchPreview: '+  expect(discountAmount(1000)).toBe(100);',
        reasons: [],
        attempts: [
          {
            id: 'A-1',
            outcome: 'improved',
            rolledBack: false,
            before: {
              testsPassed: 3,
              testsFailed: 0,
              mutantsKilled: 4,
              mutantsSurvived: 1,
              claimStatuses: {},
            },
            after: {
              testsPassed: 4,
              testsFailed: 0,
              mutantsKilled: 5,
              mutantsSurvived: 0,
              claimStatuses: {},
            },
            reasons: [],
          },
        ],
      },
    ];
    const text = renderText(input);
    expect(text).toContain('IP-0123456789ab (improved): kill the boundary mutant of discountAmount');
    expect(text).toContain('proposed test: test/pricing.test.ts: total of exactly 1000 gets the discount');
    expect(text).toContain(
      'attempt A-1: improved; before: tests 3 passed/0 failed, mutants 4 killed/1 survived; after: tests 4 passed/0 failed, mutants 5 killed/0 survived',
    );
    expect(text).toContain('+  expect(discountAmount(1000)).toBe(100);');
  });

  it('keeps the static comparison and the observed results of each property apart', () => {
    const text = renderText(fixture());
    expect(text).toMatch(
      /property-1 \[accepted, normative\]: static comparison with the code \w+; observed [^;]+;/,
    );
    expect(text).toContain(
      'property-2 [proposed, inferred]: static comparison with the code agree; observed claim-3 unsupported',
    );
  });

  it('names the formal claims behind each test assessment', () => {
    const input = fixture();
    const first = input.assessments[0];

    if (!first) throw new Error('fixture has no assessment');
    first.vector.formalEvidence = ['claim-1'];
    expect(renderText(input)).toMatch(/formal evidence claim-1 [^(]+\(conformance, assurance \w+\)/);
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

  it('shows the replay command in the run metadata of text and markdown', () => {
    const input = fixture();
    input.run.replay = 'veritas replay run-1';

    for (const output of [renderText(input), renderMarkdown(input)])
      expect(output).toContain('replay with `veritas replay run-1`');
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

describe('mutation outcomes', () => {
  it('names every mutant status instead of folding undecided ones together', () => {
    const input = fixture();
    const base = input.mutants[0];

    if (!base) throw new Error('fixture has no mutant');
    input.mutants = [
      base,
      { ...base, id: 'mutant-timeout', status: 'timeout' },
      { ...base, id: 'mutant-pending', status: 'pending' },
    ];
    const section =
      renderText(input)
        .split('\n\n')
        .find((s) => s.startsWith('6. Mutation outcomes')) ?? '';
    expect(section).toMatch(/^killed \(0\): none$/m);
    expect(section).toMatch(/^survived \(1\): /m);
    expect(section).toMatch(/^timeout \(1\): mutant-timeout /m);
    expect(section).toMatch(/^pending \(1\): mutant-pending /m);
    expect(section).toMatch(/^unknown \(0\): none$/m);
    expect(section).toMatch(/^equivalent_proven \(0\): none$/m);
    expect(section).not.toMatch(/^other/m);
  });
});

describe('property detection', () => {
  it('says how many mutants of its function each property detects', () => {
    const input = fixture();
    const base = input.claims[0];

    if (!base) throw new Error('fixture has no claim');
    input.claims = [
      ...input.claims,
      {
        ...base,
        id: 'claim-d1',
        propertyId: 'property-1',
        kind: 'property_detection',
        status: 'counterexample_found',
        mutantId: 'mutant-1',
      },
      {
        ...base,
        id: 'claim-d2',
        propertyId: 'property-1',
        kind: 'property_detection',
        status: 'proven_within_model',
        mutantId: 'mutant-1',
      },
      {
        ...base,
        id: 'claim-d3',
        propertyId: 'property-1',
        kind: 'property_detection',
        status: 'timeout',
        mutantId: 'mutant-1',
      },
    ];
    expect(renderText(input)).toMatch(
      /property-1 \[accepted, normative\]: .*; detects 1 of 3 mutant\(s\) of its function within the model \(1 undecided\)/,
    );
  });
});
