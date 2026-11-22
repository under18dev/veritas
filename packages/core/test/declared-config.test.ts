import { describe, expect, it } from 'vitest';
import { configSections, parseConfig, VeritasConfig, VeritasError } from '../src/index.js';

const declared = (extra: Record<string, unknown> = {}) => ({
  id: 'policy.pass',
  kind: 'holds_for_all',
  target: 'src/policy.ts#invariant_pass',
  description: 'pass only when nothing is open',
  ...extra,
});

describe('declared properties in the configuration', () => {
  it('defaults to none and keeps what is declared', () => {
    expect(VeritasConfig.parse({}).properties).toEqual([]);
    const config = VeritasConfig.parse({
      properties: [declared({ domain: { integer: { min: '0', max: '100' }, maxArrayLength: 2 } })],
    });
    expect(config.properties[0]).toMatchObject({
      id: 'policy.pass',
      domain: { integer: { min: '0', max: '100' }, maxArrayLength: 2 },
    });
  });

  it.each([
    ['a duplicate id', [declared(), declared()], /duplicate property id policy\.pass/],
    ['an id that is not a plain name', [declared({ id: '../x' })], /properties\.0\.id/],
    ['a target without an export name', [declared({ target: 'src/policy.ts' })], /properties\.0\.target/],
    ['an unknown kind', [declared({ kind: 'exists' })], /properties\.0\.kind/],
    ['an empty description', [declared({ description: '' })], /properties\.0\.description/],
    [
      'a domain whose min exceeds max',
      [declared({ domain: { integer: { min: '5', max: '1' } } })],
      /domain min must not exceed max/,
    ],
    ['an array length out of range', [declared({ domain: { maxArrayLength: 9 } })], /maxArrayLength/],
    ['an unknown field', [declared({ extra: true })], /properties\.0/],
  ])('rejects %s as a configuration error', (_, properties, message) => {
    let error: unknown;

    try {
      parseConfig({ properties }, '.veritas/config.json');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(VeritasError);
    expect((error as VeritasError).message).toMatch(message);
  });

  it('is not offered as a setting to editors', () => {
    expect(configSections().flatMap((s) => s.fields.map((f) => f.path[0]))).not.toContain('properties');
  });
});
