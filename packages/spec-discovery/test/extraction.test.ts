import { describe, expect, it } from 'vitest';
import { discoverEvidence, splitSentences, withoutCodeBlocks } from '../src/index.js';
import { config, tempProject, writeProjectFile } from './helpers.js';

describe('statement extraction', () => {
  it('reads no threshold from code examples in Markdown or from percentages', async () => {
    const root = tempProject('examples');
    writeProjectFile(
      root,
      'docs/guide.md',
      [
        'The bundle is up to 97% smaller.',
        '',
        '```ts',
        '// Limit to at most 3 concurrent requests.',
        'run(tasks, 3);',
        '```',
        '',
        'The count must be at most 5.',
      ].join('\n'),
    );
    const result = await discoverEvidence({ root, config: config() });
    const thresholds = result.statements.filter((s) => s.relation.kind === 'threshold');
    expect(thresholds.map((s) => [s.quote, s.range.start])).toEqual([['The count must be at most 5.', 8]]);
  });

  it('closes a code block only on a fence at least as long, and skips per cent and JSDoc examples', async () => {
    expect(withoutCodeBlocks('a\n```ts\nat most 3\n````\nb at most 4').split('\n')).toEqual([
      'a',
      '',
      '',
      '',
      'b at most 4',
    ]);
    expect(withoutCodeBlocks('````\n```\nat most 3\n````\nc').split('\n')).toEqual(['', '', '', '', 'c']);
    const root = tempProject('jsdoc');
    writeProjectFile(root, 'README.md', 'The bundle is up to 97 per cent smaller.\n');
    writeProjectFile(
      root,
      'src/limit.ts',
      [
        '/**',
        ' * Runs tasks.',
        ' * The concurrency must be at least 1.',
        ' * @example',
        ' * // at most 3 requests at a time',
        ' * limit(tasks, 3);',
        ' * @returns the results',
        ' */',
        'export function limit(tasks: unknown[], concurrency: number) { return [tasks, concurrency]; }',
      ].join('\n'),
    );
    const result = await discoverEvidence({ root, config: config() });
    const thresholds = result.statements.filter((s) => s.relation.kind === 'threshold');
    expect(thresholds.map((s) => s.quote)).toEqual(['* The concurrency must be at least 1.']);
  });

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

describe('sentence splitting', () => {
  const quotes = (text: string) => splitSentences(text).map((s) => s.text.trim());

  it('does not cut at a dot between digits, in a name or in a URL', () => {
    expect(
      quotes(
        'Requires dompurify 3.2.4 or later. Install libwebkit2gtk-4.1 first. Pi is 3.14, see https://keepachangelog.com/en/1.1.0/ and Node.js docs.',
      ),
    ).toEqual([
      'Requires dompurify 3.2.4 or later.',
      'Install libwebkit2gtk-4.1 first.',
      'Pi is 3.14, see https://keepachangelog.com/en/1.1.0/ and Node.js docs.',
    ]);
    expect(quotes('Compare v1.2.0...v1.2.1 for the diff. Done!')).toEqual([
      'Compare v1.2.0...v1.2.1 for the diff.',
      'Done!',
    ]);
  });

  it('ends a sentence at a dot before a space, but not after an abbreviation or a list number', () => {
    expect(quotes('The limit is 10. Users must log in, e.g. with a token.')).toEqual([
      'The limit is 10.',
      'Users must log in, e.g. with a token.',
    ]);
    expect(quotes('1. Install the app.\n2. The count must be at most 5.\n- 3. item')).toEqual([
      '1. Install the app.',
      '2. The count must be at most 5.',
      '- 3. item',
    ]);
    expect(quotes('if (a !== b) it fails? Then x?.y is read.')).toEqual([
      'if (a !== b) it fails?',
      'Then x?.y is read.',
    ]);
  });

  it('splits Japanese at 。 and keeps a closing bracket with its sentence', () => {
    expect(quotes('バージョン 2.1.0 以降が必要です。「設定は必須です。」次に進みます！本当？はい')).toEqual([
      'バージョン 2.1.0 以降が必要です。',
      '「設定は必須です。」',
      '次に進みます！',
      '本当？',
      'はい',
    ]);
  });

  it('drops pieces without a letter', () => {
    expect(quotes('2.\n---\n55. 4.\n| 1 | 2 |\nreal text')).toEqual(['real text']);
  });

  it('extracts no fragment statements from version-heavy documents', async () => {
    const root = tempProject('versions');
    writeProjectFile(
      root,
      'docs/ja/SECURITY.md',
      [
        '# セキュリティ',
        '',
        '- dompurify 3.2.4 以上を使います。',
        '- 依存関係: 4.0.0 → 11.2.1、55.0.1 に更新しました。',
        '1. Upgrade to 2.0.0 or later.',
      ].join('\n'),
    );
    const result = await discoverEvidence({ root, config: config(), offline: true });
    expect(result.statements.map((s) => s.quote)).toEqual([
      '- dompurify 3.2.4 以上を使います。',
      '- 依存関係: 4.0.0 → 11.2.1、55.0.1 に更新しました。',
      '1. Upgrade to 2.0.0 or later.',
    ]);
  });
});
