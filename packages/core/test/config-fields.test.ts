import { describe, expect, it } from 'vitest';
import { configSections } from '../src/index.js';

describe('configSections', () => {
  const sections = configSections();
  const find = (key: string) =>
    sections.flatMap((s) => s.fields).find((f) => f.path.join('.') === key) ?? expect.fail(key);

  it('groups every setting under its top-level key, with a description', () => {
    expect(sections.map((s) => s.key)).toEqual([
      '',
      'project',
      'sources',
      'analysis',
      'mutation',
      'pbt',
      'formal',
      'llm',
      'improvement',
      'reports',
      'policy',
      'sandbox',
      'storage',
      'cache',
      'limits',
    ]);
    for (const section of sections) {
      expect(section.description).not.toBe('');
      for (const f of section.fields) expect(f.description, f.path.join('.')).not.toBe('');
    }
  });

  it('reads types, defaults and constraints from the schema', () => {
    expect(find('mutation.timeoutMs')).toMatchObject({
      type: 'integer',
      default: 120_000,
      exclusiveMinimum: 0,
    });
    expect(find('mutation.timeoutMs').maximum).toBeUndefined();
    expect(find('sources.web.maxDepth')).toMatchObject({
      type: 'integer',
      default: 1,
      minimum: 0,
      maximum: 5,
    });
    expect(find('llm.provider')).toMatchObject({ type: 'enum', default: 'none' });
    expect(find('llm.provider').options).toContain('claude');
    expect(find('sources.github.enabled')).toMatchObject({ type: 'boolean', default: false });
    expect(find('sources.web.allowDomains')).toMatchObject({ type: 'array', default: [] });
    expect(find('reports.formats').items).toMatchObject({
      type: 'enum',
      options: expect.arrayContaining(['sarif']),
    });
    expect(find('analysis.include').minItems).toBe(1);
    expect(find('analysis.testFramework')).toMatchObject({ type: 'fixed', fixed: 'vitest' });
    expect(find('project.tsconfig')).toMatchObject({ type: 'string', nullable: true, default: null });
    expect(find('pbt.seed').default).toBeUndefined();
    // A field without a default of its own takes its parent's.
    expect(find('formal.integerDomain.min')).toMatchObject({ default: '-10000', required: true });
  });
});
