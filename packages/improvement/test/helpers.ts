import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type FormalClaim,
  type Mutant,
  type Property,
  RunStore,
  stableId,
  type TestCase,
} from '@under18dev/veritas-core';
import { ARTIFACTS } from '@under18dev/veritas-engine';
import { thresholdProperty, translateFunction } from '@under18dev/veritas-formal-core';
import { emptyCounts } from '@under18dev/veritas-mutation-adapter';

export const DOMAIN = { min: '-10000', max: '10000' };
export const HASH = 'a'.repeat(64);

export const AGE_SOURCE = `export function isSenior(age: number): boolean {
  return age >= 65;
}
`;
export const DISCOUNT_SOURCE = `export function discountAmount(total: number): number {
  if (total > 1000) {
    return 100;
  }
  return 0;
}
`;

export function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'veritas-improvement-')));
  for (const [file, content] of Object.entries({
    '.veritas/config.json': '{}\n',
    'package.json': '{ "type": "module" }\n',
    ...files,
  })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

/** A formalized threshold property for `file#exportName`, built with the real formalization helpers. */
export function thresholdPropertyOf(options: {
  file: string;
  source: string;
  exportName: string;
  param: string;
  operator: '>=' | '>' | '<=' | '<';
  value: string;
  whenTrue: string | boolean;
  whenFalse?: string | boolean;
  assumptions?: string[];
  overrides?: Partial<Property>;
}): Property {
  const translated = translateFunction({
    file: options.file,
    source: options.source,
    exportName: options.exportName,
    domain: DOMAIN,
  });
  if (translated.status !== 'translated') throw new Error(`cannot translate: ${JSON.stringify(translated)}`);
  const ir = thresholdProperty({
    implementation: translated,
    param: options.param,
    operator: options.operator,
    value: options.value,
    whenTrue: options.whenTrue,
    ...(options.whenFalse === undefined ? {} : { whenFalse: options.whenFalse }),
    domain: DOMAIN,
  });
  return {
    id: stableId('P', { file: options.file, value: options.value, op: options.operator }),
    version: 1,
    description: `${options.param} ${options.operator} ${options.value}`,
    template: 'boundary',
    targetSymbols: [`${options.file}#${options.exportName}`],
    status: 'accepted',
    origin: 'normative',
    sourceIds: ['S-readme'],
    assumptions: options.assumptions ?? [],
    inputDomain: {},
    formalExpression: `${options.param} ${options.operator} ${options.value}`,
    predicate: {
      param: options.param,
      operator: options.operator,
      value: options.value,
      consequence: 'documented rule',
    },
    statementIds: ['stmt-1'],
    citations: ['README.md:5'],
    ir,
    conflictsWith: [],
    confidence: {
      sourceQuality: 'primary',
      agreement: 'single_source',
      implementationAlignment: 'unknown',
      independence: 'independent',
      freshness: 'current',
    },
    implementationAgreement: 'unknown',
    experimental: false,
    ...options.overrides,
  };
}

export function survivedMutant(
  file: string,
  original: string,
  replacement: string,
  propertyId: string,
): Mutant {
  return {
    id: stableId('M', { file, original, replacement }),
    backendKey: 'k1',
    location: { file, range: { start: 2, end: 2 } },
    operator: 'relational',
    original,
    replacement,
    status: 'survived',
    killedBy: [],
    coveredBy: [],
    propertyIds: [propertyId],
    relevance: 'spec_relevant',
    reproduction: 'mutator --only k1',
  };
}

export function equivalenceClaim(
  propertyId: string,
  mutantId: string,
  counterexample: Record<string, string>,
): FormalClaim {
  return {
    id: stableId('C', { propertyId, mutantId }),
    propertyId,
    kind: 'bounded_equivalence',
    status: 'counterexample_found',
    engine: 'z3',
    engineVersion: 'test',
    assurance: 'smt_bounded',
    modelId: 'm',
    assumptions: [],
    scope: {},
    semanticGaps: [],
    counterexample,
    semanticValidation: 'confirmed',
    durationMs: 1,
    mutantId,
  };
}

export function assertingTest(file: string, symbol: string, arg: string): TestCase {
  return {
    id: stableId('T', { file, arg }),
    file,
    name: `checks ${arg}`,
    suitePath: [],
    location: { file },
    modifiers: [],
    assertionCount: 1,
    calledSymbols: [symbol],
    targetCalls: [{ symbol, args: [arg], asserted: true, location: { file } }],
    usesMocks: false,
    usesSnapshots: false,
    nondeterminism: [],
    suspicions: [],
    granularity: 'test',
  };
}

export interface RunInput {
  properties: Property[];
  conflicts?: {
    id: string;
    symbol: string;
    param: string;
    propertyIds: string[];
    preferredPropertyId: string | null;
    rationale: string[];
  }[];
  staleStatements?: string[];
  mutants?: Mutant[];
  claims?: FormalClaim[];
  tests?: TestCase[];
}

/** Write a synthetic run with schema-valid artifacts and return its id. */
export function writeRun(root: string, input: RunInput, runId = 'run-20260101T000000Z-aaaaaa'): string {
  const store = new RunStore(root, runId, { configHash: HASH, sourceHash: HASH, gitCommit: null });
  store.write(ARTIFACTS.properties.file, ARTIFACTS.properties.schema, {
    properties: input.properties,
    conflicts: input.conflicts ?? [],
    mapping: (input.staleStatements ?? []).map((statementId) => ({
      statementId,
      status: 'stale' as const,
      symbol: null,
      reason: 'marked stale',
    })),
    formalization: [],
    staleApprovals: [],
  });
  store.write(ARTIFACTS.claims.file, ARTIFACTS.claims.schema, input.claims ?? []);
  store.write(ARTIFACTS.testMap.file, ARTIFACTS.testMap.schema, {
    tests: input.tests ?? [],
    edges: [],
    files: [],
    diagnostics: [],
  });
  store.write(ARTIFACTS.mutation.file, ARTIFACTS.mutation.schema, {
    status: 'succeeded',
    detail: null,
    backend: { name: 'mizchi', version: '0.4.5' },
    command: [],
    exitCode: 0,
    durationMs: 1,
    mutants: input.mutants ?? [],
    counts: emptyCounts(),
    rawReportPath: null,
    agentReport: null,
    killMatrix: null,
    warnings: [],
  });
  store.write(ARTIFACTS.findings.file, ARTIFACTS.findings.schema, []);
  return runId;
}
