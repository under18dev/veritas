import type { Finding, FormalClaim, Mutant, Property, TestAssessment, TestCase } from '@veritas/core';
import { VeritasError } from '@veritas/core';
import type { DiscoveryResult } from '@veritas/spec-discovery';
import { readArtifact, readLatest } from './project.js';

export interface Explanation {
  runId: string;
  finding: Finding;
  properties: Property[];
  sources: DiscoveryResult['sources'];
  statements: DiscoveryResult['statements'];
  tests: TestCase[];
  assessments: TestAssessment[];
  mutants: Mutant[];
  claims: FormalClaim[];
}

function optional<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Follow a finding's evidence chain: sources -> properties -> tests -> mutants -> solver claims. */
export function explainFinding(root: string, findingId: string): Explanation {
  const { runId, data: findings } = readLatest(root, 'findings');
  const finding = findings.find((f) => f.id === findingId);
  if (!finding)
    throw new VeritasError(
      'user',
      'FINDING_NOT_FOUND',
      `no finding ${findingId} in run ${runId}`,
      'run `veritas report` to list findings',
    );
  const properties = optional(() => readArtifact(root, runId, 'properties').data.properties, []).filter((p) =>
    finding.propertyIds.includes(p.id),
  );
  const evidence = optional(() => readArtifact(root, runId, 'evidence').data, {
    sources: [],
    statements: [],
    provenance: [],
    skipped: [],
    networkRequests: 0,
  });
  const sourceIds = new Set([...finding.sourceIds, ...properties.flatMap((p) => p.sourceIds)]);
  const statementIds = new Set(properties.flatMap((p) => p.statementIds));
  const testMap = optional(() => readArtifact(root, runId, 'testMap').data, {
    tests: [],
    edges: [],
    files: [],
    diagnostics: [],
  });
  const testIds = new Set([
    ...finding.testIds,
    ...testMap.edges
      .filter((e) => e.propertyId && finding.propertyIds.includes(e.propertyId))
      .map((e) => e.testId),
  ]);
  const mutation = optional(() => readArtifact(root, runId, 'mutation').data.mutants, [] as Mutant[]);
  const claims = optional(() => readArtifact(root, runId, 'claims').data, [] as FormalClaim[]);
  const assessments = optional(() => readArtifact(root, runId, 'assessments').data, [] as TestAssessment[]);
  return {
    runId,
    finding,
    properties,
    sources: evidence.sources.filter((s) => sourceIds.has(s.id)),
    statements: evidence.statements.filter((s) => statementIds.has(s.id)),
    tests: testMap.tests.filter((t) => testIds.has(t.id)),
    assessments: assessments.filter((a) => testIds.has(a.testId)),
    mutants: mutation.filter(
      (m) => finding.mutantIds.includes(m.id) || m.propertyIds.some((id) => finding.propertyIds.includes(id)),
    ),
    claims: claims.filter(
      (c) => finding.claimIds.includes(c.id) || finding.propertyIds.includes(c.propertyId),
    ),
  };
}
