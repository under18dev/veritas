import type { RunSummary } from '@veritas/engine';

/** Plain-text run summary. Proven-within-model results and inferred items are labelled as such. */
export function formatRunText(summary: RunSummary): string {
  const lines = [
    `run ${summary.runId}  verdict: ${summary.decision.verdict} (exit ${summary.decision.exitCode})`,
    '',
  ];
  for (const s of summary.run.stages) {
    lines.push(`${s.status.padEnd(11)} ${s.stage}`);
    for (const m of s.messages) lines.push(`            ${m}`);
  }
  lines.push('', `findings (${summary.findings.length}):`);
  for (const f of summary.findings) lines.push(`  ${f.id}  [${f.certainty} ${f.severity}] ${f.title}`);
  if (summary.decision.reasons.length) lines.push('', ...summary.decision.reasons.map((r) => `note: ${r}`));
  lines.push(
    '',
    `explain a finding: veritas explain <finding-id>; artifacts: .veritas/runs/${summary.runId}/`,
  );
  return lines.join('\n');
}
