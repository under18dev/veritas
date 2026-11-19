import { EvidenceSource } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import { DiscoveryResult, discoverEvidence } from '../src/index.js';
import { config, tempProject, writeProjectFile } from './helpers.js';

describe('schema and code collectors', () => {
  it('extracts all JSON schema threshold keywords from JSON and YAML', async () => {
    const root = tempProject('schemas');
    writeProjectFile(
      root,
      'value.schema.json',
      JSON.stringify({ minimum: 1, maximum: 9, exclusiveMinimum: 2, exclusiveMaximum: 8 }),
    );
    writeProjectFile(
      root,
      'openapi.yaml',
      'minimum: 3\nmaximum: 7\nexclusiveMinimum: 4\nexclusiveMaximum: 6\n',
    );
    const result = await discoverEvidence({ root, config: config() });
    const thresholds = result.statements.filter(
      (s): s is typeof s & { relation: { kind: 'threshold'; value: string; operator: string } } =>
        s.relation.kind === 'threshold',
    );
    const byValue = new Map(thresholds.map((s) => [s.relation.value, s.relation.operator]));
    expect(byValue).toEqual(
      new Map([
        ['1', '>='],
        ['9', '<='],
        ['2', '>'],
        ['8', '<'],
        ['3', '>='],
        ['7', '<='],
        ['4', '>'],
        ['6', '<'],
      ]),
    );
  });

  it('collects only exported JSDoc from included source files, with original line ranges', async () => {
    const root = tempProject('jsdoc');
    writeProjectFile(
      root,
      'src/api.ts',
      `/**\n * The total must be at least 10.\n */\nexport function total(value: number) { return value; }\n\n/**\n * The hidden value must be at least 99.\n */\nfunction hidden(value: number) { return value; }\n`,
    );
    writeProjectFile(
      root,
      'test/api.test.ts',
      '/** The test value must be at least 77. */\nexport function testOnly() {}\n',
    );
    const result = await discoverEvidence({
      root,
      config: config({ analysis: { include: ['src/**/*.ts', 'test/**/*.ts'] } }),
    });
    const code = result.sources.filter((source) => source.kind === 'code');
    expect(code).toHaveLength(1);
    expect(code[0]?.range).toEqual({ start: 1, end: 10 });
    expect(result.statements.some((s) => s.relation.kind === 'threshold' && s.relation.value === '10')).toBe(
      true,
    );
    expect(
      result.statements.some(
        (s) => s.relation.kind === 'threshold' && ['77', '99'].includes(s.relation.value),
      ),
    ).toBe(false);
    expect(DiscoveryResult.parse(result)).toEqual(result);
    for (const source of result.sources) expect(EvidenceSource.parse(source)).toEqual(source);
  });

  it('collects JSDoc with the default brace include globs', async () => {
    const root = tempProject('jsdoc-default');
    writeProjectFile(root, 'src/a.ts', '/** The total must be at least 10. */\nexport function total() {}\n');
    writeProjectFile(root, 'src/b.tsx', '/** The size must be at least 20. */\nexport function size() {}\n');
    const result = await discoverEvidence({ root, config: config() });
    expect(
      result.sources
        .filter((s) => s.kind === 'code')
        .map((s) => s.locator)
        .sort(),
    ).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('records the release a changelog statement belongs to, and ends it at a heading that names no version', async () => {
    const root = tempProject('changelog');
    writeProjectFile(
      root,
      'CHANGELOG.md',
      '# Changelog\n\n## [2.0.0] - 2026-05-01\n\nA client may send at most 150 requests per minute.\n\n## Rates for 2.5 kg parcels\n\nParcels need at least 3 stamps.\n\n## v1.4\n\nA client may send at most 100 requests per minute.\n',
    );
    const result = await discoverEvidence({ root, config: config() });
    const byValue = new Map(
      result.statements
        .filter((s) => s.relation.kind === 'threshold')
        .map((s) => [s.relation.kind === 'threshold' ? s.relation.value : '', s.version]),
    );
    expect(byValue.get('150')).toBe('2.0.0');
    expect(byValue.get('3')).toBeUndefined();
    expect(byValue.get('100')).toBe('1.4');
  });

  it('links copied statements as derived and outdated documents as superseded', async () => {
    const root = tempProject('provenance');
    writeProjectFile(root, 'README.md', '# Limits\n\nA client may send at most 100 requests per minute.\n');
    writeProjectFile(
      root,
      'docs/faq.md',
      '# FAQ\n\nA client may send at most 100 requests per minute.\n\nOther notes follow here.\n',
    );
    writeProjectFile(
      root,
      'docs/limits.md',
      '# Limits v2\n\nThe README is outdated: a client may send at most 120 requests per minute.\n',
    );
    const result = await discoverEvidence({ root, config: config() });
    const id = (locator: string) => result.sources.find((s) => s.locator === locator)?.id;
    expect(result.provenance).toContainEqual({
      from: id('docs/faq.md'),
      to: id('README.md'),
      relation: 'derived_from',
    });
    expect(result.provenance).toContainEqual({
      from: id('docs/limits.md'),
      to: id('README.md'),
      relation: 'supersedes',
    });
    expect(result.sources.find((s) => s.locator === 'docs/faq.md')?.derivedFrom).toEqual([id('README.md')]);
    expect(result.provenance.some((e) => e.from === id('README.md'))).toBe(false);
  });
});
