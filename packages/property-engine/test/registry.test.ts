import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCode, inferBehaviorCandidates } from '@under18dev/veritas-code-intelligence';
import { type EvidenceSource, Property, sha256, VeritasConfig } from '@under18dev/veritas-core';
import { describe, expect, it } from 'vitest';
import {
  APPROVALS_FILE,
  applyApprovals,
  buildRegistry,
  type DiscoveryInput,
  diffRegistries,
  formalizeProperty,
  loadApprovals,
  recordDecision,
  type StatementInput,
} from '../src/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const config = VeritasConfig.parse({});

function fixture(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `veritas-pe-${name}-`)));
  cpSync(path.join(REPO, 'fixtures', name), dir, {
    recursive: true,
    filter: (s) => !s.includes('node_modules') && !s.includes('.mutator'),
  });
  return dir;
}

function source(id: string, kind: EvidenceSource['kind'], locator: string, summary = ''): EvidenceSource {
  return {
    id,
    kind,
    locator,
    capturedAt: '2026-11-19T00:00:00.000Z',
    contentHash: sha256(id),
    derivedFrom: [],
    summary,
    trust: 'untrusted_data',
  };
}

function threshold(
  id: string,
  sourceId: string,
  line: number,
  quote: string,
  quantity: string,
  operator: '<' | '<=' | '>' | '>=',
  value: string,
  consequence: string,
  flags: string[] = [],
): StatementInput {
  return {
    id,
    sourceId,
    range: { start: line, end: line },
    quote,
    modality: 'descriptive',
    subjects: [quantity],
    relation: { kind: 'threshold', quantity, operator, value, consequence },
    flags,
  };
}

const discountDiscovery: DiscoveryInput = {
  sources: [source('S-readme', 'readme', 'README.md')],
  statements: [
    threshold(
      'ST-1',
      'S-readme',
      7,
      'Orders with a total of 1000 or more receive a flat discount of 100.',
      'total',
      '>=',
      '1000',
      'receive a flat discount of 100',
    ),
    threshold(
      'ST-2',
      'S-readme',
      11,
      'Shipping is free for orders of 5000 or more. Otherwise shipping costs 500.',
      'orders',
      '>=',
      '5000',
      'Shipping is free',
    ),
  ],
  provenance: [],
};

const conflictDiscovery: DiscoveryInput = {
  sources: [
    source('S-readme', 'readme', 'README.md'),
    source(
      'S-issue',
      'issue',
      'https://github.com/example/rate-limit/issues/42',
      'Decision: fewer than 120 requests; README is outdated',
    ),
    source('S-v1', 'docs', 'docs/v1/limits.md'),
  ],
  statements: [
    threshold(
      'ST-r',
      'S-readme',
      5,
      'A client may send at most 100 requests per minute.',
      'requests',
      '<=',
      '100',
      'a client may send',
    ),
    threshold(
      'ST-i',
      'S-issue',
      1,
      'Decision: a client may send fewer than 120 requests per minute.',
      'requests',
      '<',
      '120',
      'a client may send',
    ),
    threshold(
      'ST-v',
      'S-v1',
      3,
      'A client may send at most 60 requests per minute.',
      'requests',
      '<=',
      '60',
      'a client may send',
      ['stale'],
    ),
  ],
  provenance: [],
};

function registryFor(name: string, discovery: DiscoveryInput) {
  const root = fixture(name);
  const code = analyzeCode({ root, config });
  return {
    root,
    code,
    registry: buildRegistry({ discovery, code, candidates: inferBehaviorCandidates(code) }),
  };
}

describe('registry from documentation and code', () => {
  it('maps README thresholds to the right functions and compares them with the implementation', () => {
    const { registry } = registryFor('discount-boundary', discountDiscovery);
    const discount = registry.properties.find((p) => p.statementIds.includes('ST-1'));
    const shipping = registry.properties.find((p) => p.statementIds.includes('ST-2'));
    expect(discount?.targetSymbols).toEqual(['src/pricing.ts#discountAmount']);
    expect(discount?.predicate).toMatchObject({ param: 'total', operator: '>=', value: '1000' });
    expect(discount?.implementationAgreement).toBe('disagree');
    expect(discount?.citations).toEqual(['README.md:7']);
    expect(shipping?.targetSymbols).toEqual(['src/pricing.ts#shippingFee']);
    expect(shipping?.implementationAgreement).toBe('agree');
    for (const p of registry.properties) expect(Property.parse(p)).toBeTruthy();
  });

  it('never accepts anything without an approval record', () => {
    const { registry } = registryFor('discount-boundary', discountDiscovery);
    expect(registry.properties.some((p) => p.status === 'accepted')).toBe(false);
  });

  it('keeps code-inferred candidates inferred, experimental and circular', () => {
    const { registry } = registryFor('no-spec', { sources: [], statements: [], provenance: [] });
    expect(registry.properties.length).toBeGreaterThan(0);
    for (const p of registry.properties) {
      expect(p.origin).toBe('inferred');
      expect(p.status).toBe('proposed');
      expect(p.experimental).toBe(true);
      expect(p.confidence.independence).toBe('circular');
    }
  });

  it('suggests the statement from the newer release when two release notes disagree', () => {
    const changelog = source('S-changelog', 'docs', 'CHANGELOG.md');
    const statement = (id: string, line: number, value: string, version: string): StatementInput => ({
      ...threshold(
        id,
        'S-changelog',
        line,
        `A client may send at most ${value} requests per minute.`,
        'requests',
        '<=',
        value,
        'a client may send',
      ),
      version,
    });
    const discovery = (versions: [string, string]): DiscoveryInput => ({
      sources: [changelog],
      statements: [statement('ST-old', 9, '100', versions[0]), statement('ST-new', 3, '150', versions[1])],
      provenance: [],
    });
    const { registry } = registryFor('conflicting-docs', discovery(['1.9.0', '1.10.0']));
    const newer = registry.properties.find((p) => p.statementIds.includes('ST-new'));
    expect(registry.conflicts).toHaveLength(1);
    expect(registry.conflicts[0]?.preferredPropertyId).toBe(newer?.id);
    expect(registry.conflicts[0]?.rationale.join('\n')).toMatch(/version 1\.10\.0/);
    expect(newer?.status).toBe('conflicted');
    // The same two statements without release information give no preference.
    const unversioned = registryFor('conflicting-docs', {
      ...discovery(['1.0', '1.0']),
      statements: discovery(['1.0', '1.0']).statements.map(({ version: _, ...rest }) => rest),
    });
    expect(unversioned.registry.conflicts[0]?.preferredPropertyId).toBeNull();
  });

  it('marks README and Issue as conflicted, ignores the stale document and only suggests a reading', () => {
    const { registry } = registryFor('conflicting-docs', conflictDiscovery);
    const readme = registry.properties.find((p) => p.statementIds.includes('ST-r'));
    const issue = registry.properties.find((p) => p.statementIds.includes('ST-i'));
    const stale = registry.properties.find((p) => p.statementIds.includes('ST-v'));
    expect(readme?.status).toBe('conflicted');
    expect(issue?.status).toBe('conflicted');
    expect(readme?.conflictsWith).toEqual([issue?.id]);
    expect(readme?.implementationAgreement).toBe('agree');
    expect(stale?.status).toBe('proposed');
    expect(stale?.confidence.freshness).toBe('stale');
    expect(registry.conflicts).toHaveLength(1);
    const conflict = registry.conflicts[0];
    expect(conflict?.preferredPropertyId).toBe(issue?.id);
    expect(conflict?.rationale.join('\n')).toMatch(/README\.md:5/);
    expect(conflict?.rationale.join('\n')).toMatch(/issues\/42/);
    expect(conflict?.rationale.join('\n')).toMatch(/stale/);
  });

  it('merges identical claims from two sources instead of conflicting', () => {
    const discovery: DiscoveryInput = {
      ...conflictDiscovery,
      statements: [
        conflictDiscovery.statements[0] as StatementInput,
        threshold(
          'ST-d',
          'S-v1',
          3,
          'A client may send at most 100 requests per minute.',
          'requests',
          '<',
          '101',
          'a client may send',
        ),
      ],
    };
    const { registry } = registryFor('conflicting-docs', discovery);
    expect(registry.conflicts).toHaveLength(0);
    expect(
      registry.properties
        .filter((p) => p.origin === 'normative')
        .every((p) => p.confidence.agreement === 'agree'),
    ).toBe(true);
  });

  it('leaves a statement unmapped when no function clearly matches', () => {
    const discovery: DiscoveryInput = {
      sources: [source('S-readme', 'readme', 'README.md')],
      statements: [
        threshold('ST-x', 'S-readme', 1, 'Altitude must be at least 300.', 'altitude', '>=', '300', 'must'),
      ],
      provenance: [],
    };
    const { registry } = registryFor('discount-boundary', discovery);
    expect(registry.mapping).toEqual([expect.objectContaining({ statementId: 'ST-x', status: 'unmapped' })]);
  });

  it('skips duplicates of another source', () => {
    const discovery: DiscoveryInput = {
      sources: [...discountDiscovery.sources, source('S-copy', 'docs', 'docs/copy.md')],
      statements: [
        ...discountDiscovery.statements,
        { ...(discountDiscovery.statements[0] as StatementInput), id: 'ST-copy', sourceId: 'S-copy' },
      ],
      provenance: [{ from: 'S-copy', to: 'S-readme', relation: 'duplicate_of' }],
    };
    const { registry } = registryFor('discount-boundary', discovery);
    expect(registry.mapping.find((m) => m.statementId === 'ST-copy')?.status).toBe('duplicate');
  });
});

describe('approvals', () => {
  it('records who, when, what and why, append-only, and applies only to the current version', () => {
    const { root, registry } = registryFor('conflicting-docs', conflictDiscovery);
    const issue = registry.properties.find((p) => p.statementIds.includes('ST-i')) as Property;
    const readme = registry.properties.find((p) => p.statementIds.includes('ST-r')) as Property;
    expect(() => recordDecision(root, issue, 'accept', 'alice', '')).toThrow(/reason/);
    expect(existsSync(path.join(root, APPROVALS_FILE))).toBe(false);
    const approval = recordDecision(root, issue, 'accept', 'alice', 'issue 42 is the later decision');
    expect(approval).toMatchObject({
      propertyId: issue.id,
      propertyVersion: 1,
      actor: 'alice',
      decision: 'accept',
    });
    const applied = applyApprovals(registry.properties, loadApprovals(root));
    expect(applied.properties.find((p) => p.id === issue.id)?.status).toBe('accepted');
    expect(applied.properties.find((p) => p.id === readme.id)).toMatchObject({
      status: 'superseded',
      supersededBy: issue.id,
    });

    recordDecision(root, readme, 'reject', 'bob', 'outdated');
    expect(loadApprovals(root).approvals).toHaveLength(2);
    expect(readFileSync(path.join(root, APPROVALS_FILE), 'utf8')).toContain('issue 42 is the later decision');
  });

  it('ignores approvals made for an older version of a property', () => {
    const { root, registry } = registryFor('discount-boundary', discountDiscovery);
    const discount = registry.properties.find((p) => p.statementIds.includes('ST-1')) as Property;
    recordDecision(root, discount, 'accept', 'alice', 'matches the README');
    const changed = { ...discount, description: `${discount.description} (edited)`, version: 2 };
    const applied = applyApprovals([changed], loadApprovals(root));
    expect(applied.properties[0]?.status).toBe('proposed');
    expect(applied.staleApprovals).toHaveLength(1);
  });

  it('bumps the version when content changes between runs and reports a diff', () => {
    const { code, registry } = registryFor('discount-boundary', discountDiscovery);
    const changedDiscovery: DiscoveryInput = {
      ...discountDiscovery,
      sources: [...discountDiscovery.sources, source('S-docs', 'docs', 'docs/pricing.md')],
      statements: discountDiscovery.statements.map((s) =>
        s.id === 'ST-2' ? { ...s, sourceId: 'S-docs' } : s,
      ),
    };
    const next = buildRegistry({
      discovery: changedDiscovery,
      code,
      candidates: [],
      previous: registry.properties,
    });
    const diff = diffRegistries(registry.properties, next.properties);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0]?.fields).toContain('sourceIds');
    expect(diff.changed[0]?.after.version).toBe(2);
    expect(diff.removed.every((p) => p.origin === 'inferred')).toBe(true);
  });
});

describe('formalization', () => {
  const domain = { min: '-10000', max: '10000' };

  it('formalizes the discount rule with an explicit assumption about the otherwise branch', () => {
    const { root, code, registry } = registryFor('discount-boundary', discountDiscovery);
    const discount = registry.properties.find((p) => p.statementIds.includes('ST-1')) as Property;
    const fn = code.functions.find((f) => f.symbol === 'src/pricing.ts#discountAmount');
    const result = formalizeProperty({
      root,
      property: discount,
      fn: fn as never,
      domain,
      quote: discountDiscovery.statements[0]?.quote,
    });
    expect(result.status).toBe('formalized');
    if (result.status === 'formalized') {
      expect(result.assumptions.join(' ')).toMatch(/== 100/);
      expect(result.ir.params).toEqual([{ name: 'total', sort: 'int', domain }]);
    }
  });

  it('reads "free ... otherwise 500" for shipping', () => {
    const { root, code, registry } = registryFor('discount-boundary', discountDiscovery);
    const shipping = registry.properties.find((p) => p.statementIds.includes('ST-2')) as Property;
    const fn = code.functions.find((f) => f.symbol === 'src/pricing.ts#shippingFee');
    const result = formalizeProperty({
      root,
      property: shipping,
      fn: fn as never,
      domain,
      quote: discountDiscovery.statements[1]?.quote,
    });
    expect(result.status).toBe('formalized');
    if (result.status === 'formalized') expect(result.assumptions.join(' ')).toMatch(/== 0, otherwise 500/);
  });

  it('formalizes boolean rules as "true exactly when"', () => {
    const { root, code, registry } = registryFor('conflicting-docs', conflictDiscovery);
    const readme = registry.properties.find((p) => p.statementIds.includes('ST-r')) as Property;
    const fn = code.functions.find((f) => f.symbol === 'src/limit.ts#isAllowed');
    const result = formalizeProperty({ root, property: readme, fn: fn as never, domain });
    expect(result.status).toBe('formalized');
    if (result.status === 'formalized')
      expect(result.assumptions[0]).toMatch(/returns true exactly when requestsThisMinute <= 100/);
  });

  it('refuses when the expected result cannot be read', () => {
    const { root, code, registry } = registryFor('discount-boundary', discountDiscovery);
    const discount = registry.properties.find((p) => p.statementIds.includes('ST-1')) as Property;
    const vague = {
      ...discount,
      predicate: {
        ...(discount.predicate as NonNullable<Property['predicate']>),
        consequence: 'something good happens',
      },
    };
    const fn = code.functions.find((f) => f.symbol === 'src/pricing.ts#discountAmount');
    expect(formalizeProperty({ root, property: vague, fn: fn as never, domain }).status).toBe(
      'not_formalizable',
    );
  });
});
