import type { Property } from '@under18dev/veritas-core';
import { AMBIGUOUS_BINDING, type ConflictGroup } from '@under18dev/veritas-property-engine';
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
