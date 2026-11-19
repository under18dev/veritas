import { VeritasError } from '@under18dev/veritas-core';
import {
  type ReportInput,
  renderCiSummary,
  renderHtml,
  renderJson,
  renderMarkdown,
  renderSarif,
  renderText,
} from '@under18dev/veritas-reports';
import type { ArtifactName } from './artifacts.js';
import { latestRunWith, readArtifact } from './project.js';

export type ReportFormat = 'text' | 'json' | 'markdown' | 'html' | 'sarif';

export const REPORT_FILES: Record<Exclude<ReportFormat, 'text'>, string> = {
  json: 'report.json',
  markdown: 'report.md',
  html: 'report.html',
  sarif: 'report.sarif',
};

function optional<N extends ArtifactName, T>(
  root: string,
  runId: string,
  name: N,
  pick: (data: ReturnType<typeof readArtifact<N>>['data']) => T,
  fallback: T,
): T {
  try {
    return pick(readArtifact(root, runId, name).data);
  } catch (error) {
    // A stage that did not run leaves its section empty; an artifact that exists but cannot be read is an error,
    // never an empty section that would hide its findings.
    if (error instanceof VeritasError && error.code === 'ARTIFACT_MISSING') return fallback;
    throw error;
  }
}

/** Assemble the report input of a run from its artifacts; missing optional stages become empty sections. */
export function buildReportInput(root: string, runId?: string, artifactBase = '.'): ReportInput {
  const id = runId ?? latestRunWith(root, 'run');
  if (!id) throw new VeritasError('user', 'NO_RUN', 'no run to report on', 'run `veritas run` first');
  const { meta, data: run } = readArtifact(root, id, 'run');
  const evidence = optional(root, id, 'evidence', (d) => d, {
    sources: [],
    statements: [],
    provenance: [],
    skipped: [],
    networkRequests: 0,
  });
  const properties = optional(root, id, 'properties', (d) => d, {
    properties: [],
    conflicts: [],
    mapping: [],
    formalization: [],
    staleApprovals: [],
  });
  const testMap = optional(root, id, 'testMap', (d) => d, {
    tests: [],
    edges: [],
    files: [],
    diagnostics: [],
  });
  return {
    meta,
    run,
    sources: evidence.sources,
    statements: evidence.statements.map((s) => ({
      id: s.id,
      sourceId: s.sourceId,
      range: s.range,
      quote: s.quote,
      modality: s.modality,
      flags: s.flags,
    })),
    properties: properties.properties,
    conflicts: properties.conflicts,
    tests: testMap.tests,
    edges: testMap.edges,
    assessments: optional(root, id, 'assessments', (d) => d, []),
    mutants: optional(root, id, 'mutation', (d) => d.mutants, []),
    claims: optional(root, id, 'claims', (d) => d, []),
    findings: optional(root, id, 'findings', (d) => d, []),
    artifactBase,
  };
}

export function renderReport(input: ReportInput, format: ReportFormat): string {
  switch (format) {
    case 'text':
      return renderText(input);
    case 'json':
      return renderJson(input);
    case 'markdown':
      return renderMarkdown(input);
    case 'html':
      return renderHtml(input);
    case 'sarif':
      return `${JSON.stringify(renderSarif(input), null, 2)}\n`;
  }
}

export { renderCiSummary };
