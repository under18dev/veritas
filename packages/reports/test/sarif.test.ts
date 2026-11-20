import { describe, expect, it } from 'vitest';
import { renderSarif, validateSarif } from '../src/index.js';
import { fixture } from './fixtures.js';

describe('SARIF report', () => {
  function first<T>(items: T[]): T {
    const item = items[0];

    if (item === undefined) throw new Error('expected an item');

    return item;
  }

  it('validates against the vendored schema', () => {
    expect(validateSarif(renderSarif(fixture()))).toEqual({ valid: true, errors: [] });
  });

  it('maps certainty to SARIF levels', () => {
    const results = first(renderSarif(fixture()).runs).results as Array<{
      ruleId: string;
      level: string;
      properties?: { certainty: string };
    }>;
    expect(results.find((result) => result.ruleId === 'spec_implementation_mismatch')?.level).toBe('error');
    expect(results.find((result) => result.properties?.certainty === 'suspected')?.level).toBe('note');
    expect(results.find((result) => result.properties?.certainty === 'informational')?.level).toBe('note');
  });

  it('gives every result a matching rule', () => {
    const log = renderSarif(fixture());
    const run = first(log.runs);
    const rules = new Set(run.tool.driver.rules.map((rule) => (rule as { id: string }).id));

    for (const result of run.results as Array<{ ruleId: string }>)
      expect(rules.has(result.ruleId)).toBe(true);
  });

  it('uses source-root-relative POSIX locations and line regions', () => {
    const result = first(renderSarif(fixture()).runs).results as Array<{
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string; uriBaseId: string };
          region: { startLine: number };
        };
      }>;
    }>;
    const location = first(first(result).locations).physicalLocation;
    expect(location.artifactLocation).toEqual({
      uri: 'src/discount.ts',
      uriBaseId: '%SRCROOT%',
    });
    expect(location.region.startLine).toBe(12);
  });

  it('validates findings without locations', () => {
    const log = renderSarif(fixture());
    expect(validateSarif(log).valid).toBe(true);
    expect(
      (first(log.runs).results as Array<{ locations?: unknown }>).some(
        (result) => result.locations === undefined,
      ),
    ).toBe(true);
  });

  it('rejects a deliberately broken SARIF log', () => {
    const broken = renderSarif(fixture());
    broken.version = '1.0.0' as '2.1.0';
    const result = validateSarif(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
