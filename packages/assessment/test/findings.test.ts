import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeCode } from '@under18dev/veritas-code-intelligence';
import { type Property, sha256, VeritasConfig } from '@under18dev/veritas-core';
import { AMBIGUOUS_BINDING, buildRegistry, type ConflictGroup } from '@under18dev/veritas-property-engine';
import { describe, expect, it } from 'vitest';
import { deriveFindings } from '../src/index.js';

function property(id: string, overrides: Partial<Property> = {}): Property {
  return {
    id,
    status: 'conflicted',
    origin: 'normative',
    sourceIds: ['S-changelog'],
    assumptions: [],
    experimental: false,
    implementationAgreement: 'unknown',
    predicate: { param: 'state.daysUsed', operator: '>=', value: '5', consequence: 'shows' },
    ...overrides,
  } as unknown as Property;
}

function conflictFindings(properties: Property[]) {
  const conflict: ConflictGroup = {
    id: 'CF-1',
    symbol: 'src/prompt.ts#promptBlockReason',
    param: 'state.daysUsed',
    propertyIds: properties.map((p) => p.id),
    preferredPropertyId: null,
    rationale: ['no source is clearly preferable; a human decision is required'],
  };

  return deriveFindings({
    properties,
    conflicts: [conflict],
    claims: [],
    mutants: [],
    tests: [],
    assessments: [],
    functions: [],
  }).filter((f) => f.kind === 'spec_conflict');
}

describe('spec_conflict certainty', () => {
  it('is confirmed when every reading was extracted reproducibly and bound without doubt', () => {
    const [finding] = conflictFindings([property('P-a'), property('P-b', { sourceIds: ['S-changelog'] })]);
    expect(finding?.certainty).toBe('confirmed');
    expect(finding?.sourceIds).toEqual(['S-changelog']);
  });

  it('is only suspected when one reading is an experimental (LLM-read) threshold', () => {
    const [finding] = conflictFindings([property('P-a'), property('P-b', { experimental: true })]);
    expect(finding?.certainty).toBe('suspected');
  });

  it('is only suspected when a reading could have been bound to another parameter', () => {
    const ambiguous = property('P-b', {
      assumptions: [`${AMBIGUOUS_BINDING}: promptBlockReason(state.saveCount); check before accepting`],
    });
    const [finding] = conflictFindings([property('P-a'), ambiguous]);
    expect(finding?.certainty).toBe('suspected');
  });
});

describe('spec_conflict certainty from a real registry', { timeout: 60_000 }, () => {
  it('stays confirmed for a clear conflict next to an unrelated function with the same parameter name', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-findings-')));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'src/pricing.ts'),
      `export function discountAmount(total: number): number { return total >= 1000 ? 100 : 0; }
export function shippingFee(total: number): number { return total >= 5000 ? 0 : 500; }
`,
    );
    const code = analyzeCode({ root, config: VeritasConfig.parse({}) });
    const source = (id: string, kind: 'readme' | 'docs', locator: string) => ({
      id,
      kind,
      locator,
      capturedAt: '2026-11-19T00:00:00.000Z',
      contentHash: sha256(id),
      derivedFrom: [],
      summary: '',
      trust: 'untrusted_data' as const,
    });
    const statement = (id: string, sourceId: string, value: string) => {
      const quote = `Orders with a total of ${value} or more receive a flat discount of 100.`;

      return {
        id,
        sourceId,
        range: { start: 1, end: 1 },
        quote,
        modality: 'descriptive' as const,
        subjects: ['total'],
        relation: {
          kind: 'threshold' as const,
          quantity: 'total',
          operator: '>=' as const,
          value,
          consequence: quote,
        },
        flags: [],
      };
    };
    const registry = buildRegistry({
      discovery: {
        sources: [source('S-readme', 'readme', 'README.md'), source('S-docs', 'docs', 'docs/pricing.md')],
        statements: [statement('ST-a', 'S-readme', '1000'), statement('ST-b', 'S-docs', '2000')],
        provenance: [],
      },
      code,
      candidates: [],
    });
    const findings = deriveFindings({
      properties: registry.properties,
      conflicts: registry.conflicts,
      claims: [],
      mutants: [],
      tests: [],
      assessments: [],
      functions: code.functions,
    }).filter((f) => f.kind === 'spec_conflict');
    expect(findings.map((f) => f.certainty)).toEqual(['confirmed']);
  });
});
