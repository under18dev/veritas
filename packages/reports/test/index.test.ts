import { describe, expect, it } from 'vitest';
import {
  ReportInput,
  renderCiSummary,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderSarif,
  renderText,
  reportJsonSchema,
  validateSarif,
} from '../src/index.js';

const input = ReportInput.parse({
  run: {
    id: 'run-1',
    command: 'veritas report',
    args: [],
    profile: 'standard',
    scope: { root: '.', paths: ['src'] },
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z',
    status: 'succeeded',
    exitCode: 0,
    verdict: 'pass_with_warnings',
    policyReasons: [],
    stages: [],
    capabilities: [],
    environment: { os: 'darwin', arch: 'arm64', node: '24.0.0' },
    seeds: {},
    usage: { llmTokens: 0, solverMs: 1, mutants: 1, testRuns: 1 },
    replay: 'run-1',
    partial: false,
  },
  sources: [
    {
      id: 'source-1',
      kind: 'readme',
      locator: 'README.md',
      capturedAt: '2026-01-01T00:00:00Z',
      contentHash: 'a'.repeat(64),
      derivedFrom: [],
      summary: 'discount rule',
      trust: 'untrusted_data',
    },
  ],
  statements: [
    {
      id: 'statement-1',
      sourceId: 'source-1',
      range: { start: 1, end: 1 },
      quote: '<script>',
      modality: 'must',
      flags: [],
    },
  ],
  properties: [
    {
      id: 'property-1',
      version: 1,
      description: 'discount applies at the boundary',
      template: 'boundary',
      targetSymbols: ['discount'],
      status: 'accepted',
      origin: 'normative',
      sourceIds: ['source-1'],
      assumptions: [],
      inputDomain: { min: 0, max: 1000 },
      formalExpression: 'total >= 1000',
      predicate: { param: 'total', operator: '>=', value: '1000', consequence: 'discount' },
      statementIds: ['statement-1'],
      citations: ['README.md:1'],
      conflictsWith: [],
      confidence: {
        sourceQuality: 'primary',
        agreement: 'single_source',
        implementationAlignment: 'disagree',
        independence: 'independent',
        freshness: 'current',
      },
      implementationAgreement: 'disagree',
      experimental: false,
    },
  ],
  conflicts: [],
  tests: [],
  edges: [],
  assessments: [],
  mutants: [],
  claims: [
    {
      id: 'claim-1',
      propertyId: 'property-1',
      kind: 'conformance',
      status: 'proven_within_model',
      engine: 'z3',
      engineVersion: '1',
      assurance: 'smt_bounded',
      modelId: 'm',
      assumptions: [],
      scope: { domain: '[0,1000]' },
      semanticGaps: [],
      solverInputArtifact: 'solver.smt2',
      counterexample: undefined,
      semanticValidation: 'not_attempted',
      durationMs: 1,
    },
  ],
  findings: [
    {
      id: 'finding-1',
      kind: 'spec_implementation_mismatch',
      title: '"><img onerror=alert(1)>',
      severity: 'high',
      certainty: 'confirmed',
      locations: [{ file: 'src/discount.ts', range: { start: 1, end: 1 } }],
      propertyIds: ['property-1'],
      sourceIds: ['source-1'],
      testIds: [],
      mutantIds: [],
      claimIds: ['claim-1'],
      explanation: ['boundary mismatch'],
      nextActions: [],
    },
  ],
  artifactBase: '.veritas/runs/run-1',
});

describe('reports', () => {
  it('renders deterministic redacted formats and a valid SARIF log', () => {
    expect(renderText(input)).toContain('10. Limitations');
    expect(renderMarkdown(input)).toContain('## 7. Formal claims');
    expect(renderHtml(input)).toContain('&quot;&gt;&lt;img');
    expect(renderHtml(input)).toContain('href="#claim-1"');
    expect(renderJson(input)).toBe(renderJson(input));
    expect(reportJsonSchema()).toHaveProperty('properties');
    const sarif = renderSarif(input);
    expect(validateSarif(sarif).valid).toBe(true);
    expect(renderCiSummary(input)).toContain('confirmed');
  });
});
