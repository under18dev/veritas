import type {
  Finding,
  FormalClaim,
  Mutant,
  Property,
  TestAssessment,
  TestCase,
} from '@under18dev/veritas-core';
import { isPlainRelativePath, VeritasError } from '@under18dev/veritas-core';
import type { DiscoveryResult } from '@under18dev/veritas-spec-discovery';
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

/** The evidence chain of a finding as the lines `veritas explain` prints (the TUI shows the same lines). */
export function explanationLines(explanation: Explanation): string[] {
  const f = explanation.finding;
  const lines = [
    `${f.id} [${f.certainty} ${f.severity}] ${f.kind}`,
    f.title,
    '',
    ...f.explanation.map((e) => `  ${e}`),
    '',
  ];

  for (const s of explanation.sources)
    lines.push(
      `source  ${s.kind} ${s.locator}${s.range ? `:${s.range.start}` : ''}  "${s.summary.slice(0, 120)}"`,
    );

  for (const st of explanation.statements) lines.push(`quote   line ${st.range.start}: "${st.quote}"`);

  for (const p of explanation.properties)
    lines.push(`property ${p.id} [${p.status}, ${p.origin}] ${p.description}`);

  for (const t of explanation.tests)
    lines.push(`test    ${t.file}:${t.location.range?.start ?? '?'} "${t.name}"`);

  for (const a of explanation.assessments)
    lines.push(`assess  ${a.testId}: ${a.outcome} - ${a.rationale.join('; ')}`);

  for (const m of explanation.mutants)
    lines.push(
      `mutant  ${m.id} [${m.status}] ${m.location.file}:${m.location.range?.start} ${m.original} -> ${m.replacement}`,
    );

  for (const c of explanation.claims) {
    lines.push(
      `claim   ${c.id} [${c.kind} ${c.status}, ${c.assurance}] ${c.counterexample ? JSON.stringify(c.counterexample) : ''}`,
    );

    if (c.solverInputArtifact)
      lines.push(
        `        smt: ${isPlainRelativePath(c.solverInputArtifact) ? `.veritas/runs/${explanation.runId}/${c.solverInputArtifact}` : '(unsafe location omitted)'}`,
      );
  }
  lines.push('', ...f.nextActions.map((a) => `next: ${a}`));

  return lines;
}
