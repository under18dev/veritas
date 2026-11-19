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
});
