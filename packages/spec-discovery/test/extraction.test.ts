import { describe, expect, it } from 'vitest';
import { discoverEvidence } from '../src/index.js';
import { config, tempProject, writeProjectFile } from './helpers.js';

describe('statement extraction', () => {
  it('handles every English and Japanese threshold family, separators, and modality', async () => {
    const root = tempProject('phrases');
    writeProjectFile(
      root,
      'README.md',
      [
        'The total must be at least 1,000.',
        'The total should be more than 10.',
        'The total may be at most 20.',
        'The total is no less than 30.',
        'The total is no more than 40.',
        'The total is greater than 50.',
        'The total is less than 60.',
        'A total of 70 or more is accepted.',
        'A total of 80 or less is accepted.',
        'The total is 90以上.',
        'The total is 100超.',
        'The total is 110より大きい.',
        'The total is 120以下.',
        'The total is 130未満.',
        'The value is 42.',
      ].join('\n'),
    );
    const result = await discoverEvidence({ root, config: config() });
    const thresholds = result.statements.filter(
      (s): s is typeof s & { relation: { kind: 'threshold'; value: string; operator: string } } =>
        s.relation.kind === 'threshold',
    );
    expect(new Map(thresholds.map((s) => [s.relation.value, s.relation.operator]))).toEqual(
      new Map([
        ['1000', '>='],
        ['10', '>'],
        ['20', '<='],
        ['30', '>='],
        ['40', '<='],
        ['50', '>'],
        ['60', '<'],
        ['70', '>='],
        ['80', '<='],
        ['90', '>='],
        ['100', '>'],
        ['110', '>'],
        ['120', '<='],
        ['130', '<'],
      ]),
    );
    expect(result.statements.find((s) => s.quote === 'The value is 42.')?.relation).toEqual({
      kind: 'free_text',
    });
    expect(result.statements.find((s) => s.quote.startsWith('The total must'))?.modality).toBe('must');
    expect(result.statements.find((s) => s.quote.startsWith('The total should'))?.modality).toBe('should');
    expect(result.statements.find((s) => s.quote.startsWith('The total may'))?.modality).toBe('may');
    expect(result.statements.find((s) => s.quote.startsWith('A total of 70'))?.modality).toBe('descriptive');
  });

  it('marks normalized identical source text as a later duplicate', async () => {
    const root = tempProject('duplicates');
    writeProjectFile(root, 'README.md', 'The total must be at least 10.\n');
    writeProjectFile(root, 'docs/copy.md', '  The total must be at least 10.  \n');
    const result = await discoverEvidence({ root, config: config() });
    const duplicate = result.provenance.find((edge) => edge.relation === 'duplicate_of');
    expect(duplicate).toBeDefined();
    expect(duplicate?.from).not.toBe(duplicate?.to);
    expect(
      result.statements.filter((s) => s.relation.kind === 'threshold' && s.relation.value === '10'),
    ).toHaveLength(1);
  });
});

describe('age and ordering phrases', () => {
  it.each([
    ['Visitors aged 65 or older are seniors.', '>=', '65'],
    ['Children aged 12 or younger travel free.', '<=', '12'],
    ['Versions 3 or later are supported.', '>=', '3'],
    ['Scores of 40 or lower fail.', '<=', '40'],
  ])('reads "%s" as %s %s', async (text, operator, value) => {
    const root = tempProject();
    writeProjectFile(root, 'README.md', `# x\n\n${text}\n`);
    const result = await discoverEvidence({ root, config: config(), offline: true });
    expect(result.statements[0]?.relation).toMatchObject({ kind: 'threshold', operator, value });
  });
});
