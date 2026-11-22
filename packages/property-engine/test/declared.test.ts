import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type DeclaredProperty, Property, SCHEMA_VERSION } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  applyApprovals,
  contentHash,
  declaredDomain,
  declaredProperties,
  formalizeDeclared,
} from '../src/index.js';

const DEFAULTS = { integerDomain: { min: '-10000', max: '10000' }, maxArrayLength: 3 };

const SOURCE = `export interface Evidence {
  killed: number;
  asserted: boolean;
}
function meaningful(e: Evidence): boolean {
  return e.asserted && e.killed >= 1;
}
export function invariant_meaningfulNeedsKill(e: Evidence): boolean {
  return !meaningful(e) || e.killed >= 1;
}
export function score(e: Evidence): number {
  return e.killed;
}
export function loops(n: number): boolean {
  let total = 0;
  for (let i = 0; i < n; i++) total += i;
  return total >= 0;
}
function hidden(e: Evidence): boolean {
  return e.asserted;
}
const listed = (x: number): boolean => x === x;
export { listed };
export default function invariant_default(x: number): boolean {
  return x >= x;
}
`;

function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-declared-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'kernel.ts'), SOURCE);

  return root;
}

const decl = (target: string, extra: Partial<DeclaredProperty> = {}): DeclaredProperty => ({
  id: 'meaningful-needs-kill',
  kind: 'holds_for_all',
  target,
  description: 'a meaningful outcome needs a kill',
  ...extra,
});

describe('declaredProperties', () => {
  it('makes a proposed, human property whose id comes from the declaration id', () => {
    const [p] = declaredProperties([decl('src/kernel.ts#invariant_meaningfulNeedsKill')], DEFAULTS);
    expect(Property.parse(p)).toMatchObject({
      id: 'D-meaningful-needs-kill',
      status: 'proposed',
      origin: 'human',
      template: 'state_invariant',
      targetSymbols: ['src/kernel.ts#invariant_meaningfulNeedsKill'],
      description: 'a meaningful outcome needs a kill',
      experimental: false,
    });
    // The formal settings fill in the domain the declaration leaves unset.
    expect(declaredDomain(p as Property)).toEqual({ integer: DEFAULTS.integerDomain, maxArrayLength: 3 });
  });

  it('derives the version from the content, the same on every machine', () => {
    const base = decl('src/kernel.ts#invariant_meaningfulNeedsKill');
    const [a] = declaredProperties([base], DEFAULTS);
    const [b] = declaredProperties([base], DEFAULTS);
    expect(a?.version).toBe(b?.version);
    expect(a?.version).toBeGreaterThan(0);
    const changed = [
      declaredProperties([{ ...base, description: 'other words' }], DEFAULTS)[0],
      declaredProperties([{ ...base, target: 'src/kernel.ts#listed' }], DEFAULTS)[0],
      declaredProperties([{ ...base, domain: { integer: { min: '0', max: '10000' } } }], DEFAULTS)[0],
      declaredProperties([{ ...base, domain: { maxArrayLength: 2 } }], DEFAULTS)[0],
      declaredProperties([base], { ...DEFAULTS, integerDomain: { min: '0', max: '5' } })[0],
    ];
    for (const p of changed) expect(p?.version).not.toBe(a?.version);
    // The id stays: an approval of the old version no longer applies.
    for (const p of changed) expect(p?.id).toBe(a?.id);
  });

  it('is accepted only through an approval of its current version', () => {
    const [p] = declaredProperties([decl('src/kernel.ts#invariant_meaningfulNeedsKill')], DEFAULTS);
    const property = p as Property;
    const approval = (version: number) => ({
      id: 'A-1',
      propertyId: property.id,
      propertyVersion: version,
      decision: 'accept' as const,
      actor: 'reviewer',
      reason: 'reviewed',
      decidedAt: '2026-01-01T00:00:00.000Z',
      sourceIds: [],
    });
    const none = applyApprovals([property], { schemaVersion: SCHEMA_VERSION, approvals: [] });
    expect(none.properties[0]?.status).toBe('proposed');
    const current = applyApprovals([property], {
      schemaVersion: SCHEMA_VERSION,
      approvals: [approval(property.version)],
    });
    expect(current.properties[0]?.status).toBe('accepted');
    const stale = applyApprovals([property], {
      schemaVersion: SCHEMA_VERSION,
      approvals: [approval(property.version + 1)],
    });
    expect(stale.properties[0]?.status).toBe('proposed');
    expect(stale.staleApprovals).toHaveLength(1);
  });

  it('leaves the content hash of discovered properties unchanged', () => {
    const [p] = declaredProperties([decl('src/kernel.ts#invariant_meaningfulNeedsKill')], DEFAULTS);
    const normative = { ...(p as Property), origin: 'normative' as const };
    const other = { ...normative, inputDomain: { total: 'integer' } };
    expect(contentHash(normative)).toBe(contentHash(other));
    expect(contentHash(p as Property)).not.toBe(contentHash({ ...(p as Property), inputDomain: {} }));
  });
});

describe('formalizeDeclared', () => {
  const formalize = (root: string, target: string, extra: Partial<DeclaredProperty> = {}) => {
    const [p] = declaredProperties([decl(target, extra)], DEFAULTS);

    return formalizeDeclared({ root, property: p as Property });
  };

  it('formalizes a boolean function as true for every input in the domain', () => {
    const root = project();
    const result = formalize(root, 'src/kernel.ts#invariant_meaningfulNeedsKill', {
      domain: { integer: { min: '0', max: '50' } },
    });
    expect(result.status).toBe('formalized');

    if (result.status !== 'formalized') return;
    expect(result.exportName).toBe('invariant_meaningfulNeedsKill');
    expect(result.file).toBe('src/kernel.ts');
    expect(result.ir.params).toEqual([
      { name: 'e__killed', sort: 'int', domain: { min: '0', max: '50' } },
      { name: 'e__asserted', sort: 'bool' },
    ]);
    expect(result.ir.body).toMatchObject({
      kind: 'binary',
      op: '==',
      left: { kind: 'call', fn: 'invariant_meaningfulNeedsKill' },
      right: { kind: 'bool', value: true },
    });
    expect(result.assumptions.join(' ')).toContain('returns true for every input');
  });

  it('accepts a function exported through an export list', () => {
    expect(formalize(project(), 'src/kernel.ts#listed').status).toBe('formalized');
  });

  it.each([
    ['src/missing.ts#invariant', /target file src\/missing\.ts does not exist/],
    ['src/kernel.ts#nothing', /exports no function named nothing/],
    ['src/kernel.ts#hidden', /exports no function named hidden/],
    ['src/kernel.ts#invariant_default', /exports no function named invariant_default/],
    [
      'src/kernel.ts#score',
      /returns a number; a holds_for_all property needs a function that returns a boolean/,
    ],
    ['src/kernel.ts#loops', /outside the supported subset: line \d+: /],
    ['../outside.ts#invariant', /escapes the project root/],
    ['src#invariant', /target file src does not exist/],
  ])('reports %s as not formalizable, with the reason', (target, reason) => {
    const result = formalize(project(), target);
    expect(result.status).toBe('not_formalizable');

    if (result.status === 'not_formalizable') expect(result.reason).toMatch(reason);
  });

  it('refuses a target reached through a symlink that leaves the project', () => {
    const root = project();
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-declared-out-')));
    writeFileSync(path.join(outside, 'k.ts'), SOURCE);
    symlinkSync(outside, path.join(root, 'linked'), 'junction');
    const result = formalize(root, 'linked/k.ts#invariant_meaningfulNeedsKill');
    expect(result.status).toBe('not_formalizable');
  });
});
