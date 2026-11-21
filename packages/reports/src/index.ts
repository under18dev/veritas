import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ArtifactMeta,
  EvidenceSource,
  Finding,
  FormalClaim,
  isPlainRelativePath,
  MeasurementSnapshot,
  Mutant,
  MutantStatus,
  Property,
  Run,
  redactDeep,
  TestAssessment,
  TestCase,
  TestPropertyEdge,
} from '@under18dev/veritas-core';
import addDraft4 from 'ajv-draft-04';
import { toJSONSchema, z } from 'zod';

const Statement = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }),
  quote: z.string(),
  modality: z.string(),
  flags: z.array(z.string()),
});
/** An improvement plan made from this run, with its apply attempts (before/after measurements). */
const Improvement = z.object({
  planId: z.string().min(1),
  outcome: z.string(),
  goal: z.string().nullable(),
  proposedTests: z.array(z.string()),
  patchPreview: z.string(),
  reasons: z.array(z.string()),
  attempts: z.array(
    z.object({
      id: z.string().min(1),
      outcome: z.string(),
      rolledBack: z.boolean(),
      before: MeasurementSnapshot.nullable(),
      after: MeasurementSnapshot.nullable(),
      reasons: z.array(z.string()),
    }),
  ),
});
export type ReportImprovement = z.infer<typeof Improvement>;
const Conflict = z.object({
  id: z.string().min(1),
  symbol: z.string(),
  param: z.string(),
  propertyIds: z.array(z.string()),
  preferredPropertyId: z.string().nullable(),
  rationale: z.array(z.string()),
});

export const ReportInput = z.object({
  /** Traceability metadata of the run (from the `run.json` envelope). */
  meta: ArtifactMeta,
  run: Run,
  sources: z.array(EvidenceSource),
  statements: z.array(Statement),
  properties: z.array(Property),
  conflicts: z.array(Conflict),
  tests: z.array(TestCase),
  edges: z.array(TestPropertyEdge),
  assessments: z.array(TestAssessment),
  mutants: z.array(Mutant),
  claims: z.array(FormalClaim),
  findings: z.array(Finding),
  improvements: z.array(Improvement).default([]),
  artifactBase: z.string(),
});
export type ReportInput = z.infer<typeof ReportInput>;
export type ReportStatement = z.infer<typeof Statement>;
export type SarifLog = {
  version: '2.1.0';
  $schema: string;
  runs: Array<{
    tool: { driver: { name: string; version?: string; rules: unknown[] } };
    properties?: Record<string, unknown>;
    results: unknown[];
  }>;
};

const ReportDocument = z.object({
  schemaVersion: z.literal('1.0.0'),
  meta: ArtifactMeta,
  run: Run,
  sources: z.array(EvidenceSource),
  statements: z.array(Statement),
  properties: z.array(Property),
  conflicts: z.array(Conflict),
  tests: z.array(TestCase),
  edges: z.array(TestPropertyEdge),
  assessments: z.array(TestAssessment),
  mutants: z.array(Mutant),
  claims: z.array(FormalClaim),
  findings: z.array(Finding),
  improvements: z.array(Improvement),
  artifactBase: z.string(),
});

function safe(input: ReportInput): ReportInput {
  const parsed = redactDeep(ReportInput.parse(input)) as ReportInput;
  const byId = <T extends { id: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));

  return {
    ...parsed,
    sources: byId(parsed.sources),
    statements: byId(parsed.statements),
    properties: byId(parsed.properties),
    conflicts: byId(parsed.conflicts),
    tests: byId(parsed.tests),
    edges: byId(parsed.edges),
    assessments: [...parsed.assessments].sort((a, b) => a.testId.localeCompare(b.testId)),
    mutants: byId(parsed.mutants),
    claims: byId(parsed.claims),
    findings: byId(parsed.findings),
    improvements: [...parsed.improvements].sort((a, b) => a.planId.localeCompare(b.planId)),
    run: { ...parsed.run, stages: [...parsed.run.stages].sort((a, b) => a.stage.localeCompare(b.stage)) },
  };
}

function statusText(value: string): string {
  return value === 'proven_within_model'
    ? 'proven within the model'
    : value === 'inferred'
      ? 'inferred (not a specification)'
      : value;
}

function claimText(claim: FormalClaim, artifactBase: string): string {
  const scope = JSON.stringify(claim.scope);
  const domain = claim.scope.domain ? `, domain ${JSON.stringify(claim.scope.domain)}` : '';
  const artifact = claim.solverInputArtifact
    ? `, solver input ${safeArtifactHref(artifactBase, claim.solverInputArtifact) ?? '(unsafe location omitted)'}`
    : '';

  return `${claim.kind}: ${statusText(claim.status)}${domain}; assurance ${claim.assurance}; scope ${scope}; assumptions ${claim.assumptions.join('; ') || 'none'}; semantic gaps ${claim.semanticGaps.join('; ') || 'none'}; counterexample ${claim.counterexample ? JSON.stringify(claim.counterexample) : 'none'}${artifact}; reproduction ${claim.reproduction ?? 'none'}`;
}

function snapshot(m: z.infer<typeof MeasurementSnapshot> | null): string {
  return m
    ? `tests ${m.testsPassed} passed/${m.testsFailed} failed, mutants ${m.mutantsKilled} killed/${m.mutantsSurvived} survived`
    : 'not measured';
}

function improvementText(i: ReportImprovement): string {
  return [
    `${i.planId} (${i.outcome}): ${i.goal ?? 'no plan'}`,
    ...i.proposedTests.map((t) => `  proposed test: ${t}`),
    ...i.reasons.map((r) => `  reason: ${r}`),
    ...i.attempts.map(
      (a) =>
        `  attempt ${a.id}: ${a.outcome}${a.rolledBack ? ' (rolled back)' : ''}; before: ${snapshot(a.before)}; after: ${snapshot(a.after)}${a.reasons.length ? `; ${a.reasons.join('; ')}` : ''}`,
    ),
    ...(i.patchPreview ? ['  patch preview:', ...i.patchPreview.split('\n').map((l) => `    ${l}`)] : []),
  ].join('\n');
}

/**
 * The evidence behind one property, with the static comparison of the code and what running it showed kept
 * apart: tests linked to it, mutants of its code, formal claims and property-based counterexamples.
 */
function propertyEvidence(i: ReportInput, p: Property): string {
  const tests = i.edges.filter((e) => e.propertyId === p.id);
  const mutants = i.mutants.filter((m) => m.propertyIds.includes(p.id));
  const killed = mutants.filter((m) => m.status === 'killed').length;
  const survived = mutants.filter((m) => m.status === 'survived').length;
  const claims = i.claims.filter((c) => c.propertyId === p.id && c.kind === 'conformance');
  const observedCounterexamples = i.findings.filter(
    (f) => f.kind === 'counterexample' && f.propertyIds.includes(p.id),
  );
  const observed = [
    ...claims.map((c) => `${c.id} ${statusText(c.status)}`),
    ...observedCounterexamples.map((f) => `${f.id} counterexample`),
  ];
  const detection = i.claims.filter((c) => c.propertyId === p.id && c.kind === 'property_detection');
  const detected = detection.filter((c) => c.status === 'counterexample_found').length;
  const undecided = detection.filter(
    (c) => c.status !== 'counterexample_found' && c.status !== 'proven_within_model',
  ).length;
  const detectionText = detection.length
    ? `; detects ${detected} of ${detection.length} mutant(s) of its function within the model${undecided ? ` (${undecided} undecided)` : ''}`
    : '';

  return `${p.id} [${p.status}, ${p.origin}]: static comparison with the code ${p.implementationAgreement}; observed ${observed.join(', ') || 'not run'}; tests ${tests.map((e) => `${e.testId} (${e.evidence.map((x) => x.kind).join('+') || 'none'})`).join(', ') || 'none'}; mutants ${killed} killed, ${survived} survived of ${mutants.length}${detectionText}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Where a summarized Markdown report sends the reader for the complete lists. */
const FULL_LISTS =
  'The JSON and HTML reports list them all (report.json and report.html of the run, or `veritas report --format json`).';
/** Sources shown per kind, and quotes per source, in the Markdown summary of the evidence. */
const EXAMPLE_SOURCES = 3;
const EXAMPLE_QUOTES = 2;
/** Inferred properties whose evidence the Markdown report shows; the others are counted. */
const EXAMPLE_INFERRED = 5;

/**
 * The evidence as counts per source kind, with the sources that have the most statements as examples. A run that
 * reads the web and many documents collects thousands of statements, which made the Markdown report megabytes long.
 */
function evidenceSummary(i: ReportInput): string {
  if (i.sources.length === 0) return 'none';
  const statementsOf = new Map<string, ReportInput['statements']>();

  for (const st of i.statements) {
    const list = statementsOf.get(st.sourceId);

    if (list) list.push(st);
    else statementsOf.set(st.sourceId, [st]);
  }
  const count = (id: string) => statementsOf.get(id)?.length ?? 0;
  const kinds = [...new Set(i.sources.map((s) => s.kind))].sort();
  const lines = [
    `${plural(i.sources.length, 'source', 'sources')}, ${plural(i.statements.length, 'statement', 'statements')}. By kind, with the sources that have the most statements:`,
  ];

  for (const kind of kinds) {
    const members = i.sources.filter((s) => s.kind === kind);
    const statements = members.reduce((sum, s) => sum + count(s.id), 0);
    lines.push(
      `- ${kind}: ${plural(members.length, 'source', 'sources')}, ${plural(statements, 'statement', 'statements')}`,
    );

    for (const s of [...members]
      // A plain comparison, so the examples do not depend on the locale of the machine.
      .sort(
        (a, b) => count(b.id) - count(a.id) || (a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0),
      )
      .slice(0, EXAMPLE_SOURCES))
      lines.push(
        `  - ${s.id}: ${s.kind} ${s.locator}${s.range ? `:${s.range.start}` : ''}, ${plural(count(s.id), 'statement', 'statements')}${(
          statementsOf.get(s.id) ?? []
        )
          .slice(0, EXAMPLE_QUOTES)
          .map((st) => `; quote ${st.quote}`)
          .join('')}`,
      );
  }
  lines.push(FULL_LISTS);

  return lines.join('\n');
}

/**
 * Sections of the text, Markdown and HTML reports. `brief` (the Markdown report) summarizes the collected evidence
 * and the inferred properties, which can run to thousands of lines; the other formats keep every entry.
 */
function sections(input: ReportInput, brief = false): string[] {
  const i = safe(input);
  const run = i.run;
  const props = (status: string[]) => i.properties.filter((p) => status.includes(p.status));
  const ledger = (members: Property[], label: (p: Property) => string) => {
    const shown = brief ? members.filter((p) => p.origin !== 'inferred') : members;
    const inferred = members.length - shown.length;

    return [...shown.map(label), ...(inferred ? [`${inferred} inferred`] : [])].join(', ') || 'none';
  };
  const ledgerEntries = i.properties.filter((p) => p.status !== 'rejected' && p.status !== 'superseded');
  const inferredEntries = ledgerEntries.filter((p) => p.origin === 'inferred');
  const detailed = brief
    ? [...ledgerEntries.filter((p) => p.origin !== 'inferred'), ...inferredEntries.slice(0, EXAMPLE_INFERRED)]
    : ledgerEntries;
  const hiddenInferred = ledgerEntries.length - detailed.length;
  const inferredCount = i.properties.filter((p) => p.origin === 'inferred').length;
  // Every status by name: undecided outcomes (timeout, pending, unknown ...) are never folded into the others.
  const alwaysShown = new Set(['killed', 'survived', 'unknown', 'equivalent_proven']);
  const mutationGroups = MutantStatus.options
    .filter((status) => alwaysShown.has(status) || i.mutants.some((m) => m.status === status))
    .map((status) => {
      const members = i.mutants.filter((m) => m.status === status);

      return `${status} (${members.length}): ${members.map((m) => `${m.id} ${m.original} -> ${m.replacement}`).join('; ') || 'none'}`;
    });

  return [
    `1. Run metadata/environment/scope\nrun ${run.id}; command ${run.command} ${run.args.join(' ')}; profile ${run.profile ?? 'none'}; git commit ${i.meta.gitCommit ?? 'none (not a git repository)'}${run.scope.since ? `; changes since ${run.scope.since}` : ''}; Veritas ${i.meta.toolVersion}; schema ${i.meta.schemaVersion}; config hash ${i.meta.configHash}; source hash ${i.meta.sourceHash}; OS ${run.environment.os}; Node ${run.environment.node}; verdict ${run.verdict ?? 'none'}; exit code ${run.exitCode ?? 'none'}; scope ${run.scope.root} (${run.scope.paths.join(', ') || 'all'}); policy reasons ${run.policyReasons.join('; ') || 'none'}; replay with \`${run.replay}\``,
    `2. Collected evidence with provenance\n${
      brief
        ? evidenceSummary(i)
        : i.sources
            .map(
              (s) =>
                `${s.id}: ${s.kind} ${s.locator}${s.range ? `:${s.range.start}` : ''} — ${s.summary}${i.statements
                  .filter((statement) => statement.sourceId === s.id)
                  .map((statement) => `; quote ${statement.quote}`)
                  .join('')}`,
            )
            .join('\n') || 'none'
    }`,
    `3. Property ledger\naccepted: ${ledger(props(['accepted']), (p) => `${p.id} (${p.origin})`)}\nproposed: ${ledger(
      props(['proposed']),
      (p) => `${p.id} (${p.origin})`,
    )}\nconflicted: ${ledger(props(['conflicted']), (p) => `${p.id} (${p.origin})`)}\nother: ${ledger(
      props(['reviewed', 'rejected', 'superseded']),
      (p) => `${p.id} (${p.status}, ${p.origin})`,
    )}${detailed.map((p) => `\n${propertyEvidence(i, p)}`).join('')}${
      hiddenInferred
        ? `\n... and ${plural(hiddenInferred, 'more inferred property', 'more inferred properties')} (not specifications). ${FULL_LISTS}`
        : ''
    }`,
    `4. Specification vs implementation mismatches\n${
      i.findings
        .filter((f) => f.kind === 'spec_implementation_mismatch')
        .map((f) => `${f.id} [${f.certainty}, ${f.severity}]: ${f.title}`)
        .join('\n') || 'none'
    }`,
    `5. Tests x properties matrix\n${
      i.tests
        .map(
          (t) =>
            `${t.id}: ${
              i.edges
                .filter((e) => e.testId === t.id)
                .map(
                  (e) =>
                    `${e.propertyId ?? 'unmapped'} [${e.evidence.map((x) => x.kind).join(', ') || 'none'}]`,
                )
                .join('; ') || 'none'
            }`,
        )
        .join('\n') || 'none'
    }`,
    `6. Mutation outcomes\n${mutationGroups.join('\n')}`,
    `7. Formal claims\n${i.claims.map((c) => `${c.id}: ${claimText(c, i.artifactBase)}`).join('\n') || 'none'}`,
    `8. Test assessments\n${
      i.assessments
        .map((a) => {
          const formal = a.vector.formalEvidence.map((id) => {
            const c = i.claims.find((x) => x.id === id);

            return c ? `${id} ${statusText(c.status)} (${c.kind}, assurance ${c.assurance})` : id;
          });

          return `${a.testId}: ${a.outcome}; rationale ${a.rationale.join('; ')}; formal evidence ${formal.join(', ') || 'none'}; unknowns ${a.vector.unknowns.join('; ') || 'none'}`;
        })
        .join('\n') || 'none'
    }`,
    `9. Improvement proposals\n${i.improvements.map(improvementText).join('\n') || 'none for this run (see `veritas improve --dry-run`)'}`,
    `10. Limitations\n${[...run.stages.filter((s) => s.status !== 'succeeded').map((s) => `stage ${s.stage} was ${s.status}`), ...i.claims.filter((c) => ['unsupported', 'semantic_mismatch', 'timeout', 'unknown'].includes(c.status)).map((c) => `claim ${c.id} is ${c.status}`), ...(inferredCount ? [`${plural(inferredCount, 'property is', 'properties are')} inferred (not a specification)`] : [])].join('; ') || 'none'}`,
  ];
}

export function renderText(input: ReportInput): string {
  return sections(input).join('\n\n');
}

export function renderJson(input: ReportInput): string {
  const parsed = ReportDocument.parse({ ...safe(input), schemaVersion: '1.0.0' });

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function reportJsonSchema(): object {
  return {
    $id: 'https://veritas.invalid/schemas/report.json',
    ...toJSONSchema(ReportDocument, { io: 'input', target: 'draft-07', unrepresentable: 'any' }),
  };
}

export function renderMarkdown(input: ReportInput): string {
  const i = safe(input);
  const body = sections(i, true)
    .map((s) => {
      const [title, ...rest] = s.split('\n');

      return `## ${title}\n\n${rest.join('\n')}`;
    })
    .join('\n\n');

  return `# Veritas report: ${i.run.id}\n\n${body.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n`;
}

/**
 * A link target for a run artifact, or null when either part is not a plain relative path (see
 * `isPlainRelativePath`): URL schemes, absolute paths, backslashes and `.`/`..` segments could point anywhere.
 * The base may also be `.`.
 */
export function safeArtifactHref(base: string, artifact: string): string | null {
  const trimmed = base.replace(/\/$/, '');
  if (!isPlainRelativePath(artifact) || (trimmed !== '.' && !isPlainRelativePath(trimmed))) return null;
  return `${trimmed}/${artifact}`;
}

function artifactLink(base: string, artifact: string): string {
  const href = safeArtifactHref(base, artifact);

  return href
    ? `<p><a href="${htmlEscape(href)}">solver input artifact</a></p>`
    : `<p>solver input artifact: ${htmlEscape(artifact)} (link omitted: unsafe location)</p>`;
}

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function anchor(id: string): string {
  return `<a id="${htmlEscape(id)}"></a>`;
}

function relationLinks(ids: string[], label: string): string {
  return ids.length
    ? `<p>${label}: ${ids.map((id) => `<a href="#${htmlEscape(id)}">${htmlEscape(id)}</a>`).join(', ')}</p>`
    : '';
}

export function renderHtml(input: ReportInput): string {
  const i = safe(input);
  const findingBlocks = i.findings
    .map(
      (f) =>
        `<article>${anchor(f.id)}<h3>${htmlEscape(f.title)}</h3><p>${htmlEscape(f.certainty)} — ${htmlEscape(f.severity)}</p><p>${f.explanation.map(htmlEscape).join('<br>')}</p>${relationLinks(f.sourceIds, 'Sources')}${relationLinks(f.propertyIds, 'Properties')}${relationLinks(f.testIds, 'Tests')}${relationLinks(f.mutantIds, 'Mutants')}${relationLinks(f.claimIds, 'Claims')}</article>`,
    )
    .join('');
  const sources = i.sources
    .map(
      (s) =>
        `<article>${anchor(s.id)}<h3>${htmlEscape(s.id)} — ${htmlEscape(s.kind)}</h3><p>${htmlEscape(s.locator)}${s.range ? `:${s.range.start}` : ''}</p><blockquote>${htmlEscape(s.summary)}</blockquote>${i.statements
          .filter((statement) => statement.sourceId === s.id)
          .map((statement) => `<p>${htmlEscape(statement.range.start)}: ${htmlEscape(statement.quote)}</p>`)
          .join('')}</article>`,
    )
    .join('');
  const properties = i.properties
    .map(
      (p) =>
        `<article>${anchor(p.id)}<h3>${htmlEscape(p.id)} — ${htmlEscape(p.status)}</h3><p>${htmlEscape(p.description)}; origin ${htmlEscape(p.origin)}${p.origin === 'inferred' ? ' (inferred (not a specification))' : ''}</p>${relationLinks(p.sourceIds, 'Sources')}${relationLinks(
          i.edges.filter((e) => e.propertyId === p.id).map((e) => e.testId),
          'Tests',
        )}</article>`,
    )
    .join('');
  const tests = i.tests
    .map(
      (t) =>
        `<article>${anchor(t.id)}<h3>${htmlEscape(t.id)} — ${htmlEscape(t.name)}</h3><p>${htmlEscape(t.file)}</p>${relationLinks(
          i.mutants.filter((m) => m.coveredBy.includes(t.id)).map((m) => m.id),
          'Mutants',
        )}</article>`,
    )
    .join('');
  const mutants = i.mutants
    .map(
      (m) =>
        `<article>${anchor(m.id)}<h3>${htmlEscape(m.id)} — ${htmlEscape(m.status)}</h3><p>${htmlEscape(m.original)} → ${htmlEscape(m.replacement)}</p>${relationLinks(m.propertyIds, 'Properties')}${relationLinks(m.killedBy, 'Tests')}${relationLinks(
          i.claims.filter((claim) => claim.mutantId === m.id).map((claim) => claim.id),
          'Claims',
        )}</article>`,
    )
    .join('');
  const claims = i.claims
    .map(
      (c) =>
        `<article>${anchor(c.id)}<h3>${htmlEscape(c.id)} — ${htmlEscape(statusText(c.status))}</h3><p>${htmlEscape(claimText(c, i.artifactBase))}</p>${c.solverInputArtifact ? artifactLink(i.artifactBase, c.solverInputArtifact) : ''}</article>`,
    )
    .join('');
  const table = `<table><thead><tr><th scope="col">Test</th><th scope="col">Property</th><th scope="col">Evidence</th></tr></thead><tbody>${i.edges.map((e) => `<tr><td><a href="#${htmlEscape(e.testId)}">${htmlEscape(e.testId)}</a></td><td>${e.propertyId ? `<a href="#${htmlEscape(e.propertyId)}">${htmlEscape(e.propertyId)}</a>` : 'unmapped'}</td><td>${htmlEscape(e.evidence.map((x) => x.kind).join(', ') || 'none')}</td></tr>`).join('')}</tbody></table>`;
  const reportSections = sections(i);
  const metadata = reportSections[0] ?? '';
  const evidence = reportSections[1] ?? '';
  const propertyLedger = reportSections[2] ?? '';
  const mismatches = reportSections[3] ?? '';
  const matrix = reportSections[4] ?? '';
  const mutation = reportSections[5] ?? '';
  const formal = reportSections[6] ?? '';
  const assessments = reportSections[7] ?? '';
  const improvements = reportSections[8] ?? '';
  const limitations = reportSections[9] ?? '';
  const section = (heading: string, body: string, content: string) =>
    `<section><h2>${heading}</h2><pre>${htmlEscape(body)}</pre>${content}</section>`;
  return withoutDanglingLinks(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Veritas report ${htmlEscape(i.run.id)}</title><style>body{font-family:system-ui,sans-serif;line-height:1.45;max-width:1100px;margin:2rem auto;padding:0 1rem}article{border:1px solid #bbb;padding:.75rem;margin:.75rem 0}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.4rem;text-align:left}blockquote{white-space:pre-wrap}pre{white-space:pre-wrap}</style></head><body><h1>Veritas report</h1>${section('1. Run metadata/environment/scope', metadata, `<p>${htmlEscape(i.run.id)} — ${htmlEscape(i.run.verdict ?? 'none')} — ${htmlEscape(i.run.environment.os)} — Node ${htmlEscape(i.run.environment.node)}</p>`)}${section('2. Collected evidence with provenance', evidence, sources || '<p>none</p>')}${section('3. Property ledger', propertyLedger, properties || '<p>none</p>')}${section('4. Specification vs implementation mismatches', mismatches, findingBlocks || '<p>none</p>')}${section('5. Tests x properties matrix', matrix, `${table}${tests || '<p>none</p>'}`)}${section('6. Mutation outcomes', mutation, mutants || '<p>none</p>')}${section('7. Formal claims', formal, claims || '<p>none</p>')}${section('8. Test assessments', assessments, `<p>${htmlEscape(i.assessments.map((assessment) => `${assessment.testId}: ${assessment.outcome}; ${assessment.rationale.join('; ')}`).join('\n') || 'none')}</p>`)}${section('9. Improvement proposals', improvements, i.improvements.map((imp) => `<article>${anchor(imp.planId)}<h3>${htmlEscape(imp.planId)} — ${htmlEscape(imp.outcome)}</h3><p>${htmlEscape(imp.goal ?? 'no plan')}</p></article>`).join('') || '<p>none</p>')}${section('10. Limitations', limitations, `<p>${htmlEscape(limitations.replace(/^10\. Limitations\n/, ''))}</p>`)}</body></html>`,
  );
}

/** In-page links whose target is not in the page (an id the report has no item for) become plain text. */
function withoutDanglingLinks(html: string): string {
  const ids = new Set([...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]));
  return html.replace(/<a href="#([^"]*)">([^<]*)<\/a>/g, (link, id: string, text: string) =>
    ids.has(id) ? link : `${text} (not in this report)`,
  );
}

function sarifLevel(f: Finding): 'error' | 'warning' | 'note' {
  if (f.certainty !== 'confirmed') return 'note';

  return f.kind === 'spec_implementation_mismatch' ? 'error' : 'warning';
}

export function renderSarif(input: ReportInput): SarifLog {
  const i = safe(input);
  const kinds = [...new Set(i.findings.map((f) => f.kind))];

  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'veritas',
            version: i.meta.toolVersion,
            rules: kinds.map((id) => ({ id, shortDescription: { text: id } })),
          },
        },
        properties: { veritas: i.meta },
        results: i.findings.map((f) => ({
          ruleId: f.kind,
          level: sarifLevel(f),
          message: { text: f.title },
          properties: f.certainty === 'suspected' ? { certainty: 'suspected' } : { certainty: f.certainty },
          // Only project-relative files: a location such as `../x` or `/etc/x` is not part of the source root.
          locations: f.locations.some((l) => isPlainRelativePath(l.file.replaceAll('\\', '/')))
            ? f.locations
                .filter((l) => isPlainRelativePath(l.file.replaceAll('\\', '/')))
                .map((l) => ({
                  physicalLocation: {
                    artifactLocation: { uri: l.file.replaceAll('\\', '/'), uriBaseId: '%SRCROOT%' },
                    ...(l.range ? { region: { startLine: l.range.start, endLine: l.range.end } } : {}),
                  },
                }))
            : undefined,
        })),
      },
    ],
  };
}

export function validateSarif(log: SarifLog): { valid: boolean; errors: string[] } {
  const schema = JSON.parse(
    readFileSync(fileURLToPath(new URL('../schemas/sarif-schema-2.1.0.json', import.meta.url)), 'utf8'),
  ) as object;
  const Draft4Ajv = addDraft4 as unknown as {
    new (
      options?: object,
    ): {
      compile(
        schema: object,
      ): ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> };
      errors?: Array<{ instancePath?: string; message?: string }>;
    };
  };
  const ajv = new Draft4Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(log);

  return {
    valid: Boolean(valid),
    errors: valid
      ? []
      : (validate.errors ?? []).map(
          (e: { instancePath?: string; message?: string }) =>
            `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
        ),
  };
}

/** An http(s) URL or a plain relative path; anything else (`javascript:` ...) is not linked. */
function safeReportUrl(url: string): boolean {
  return /^https?:\/\/[^\s()<>]+$/i.test(url) || (isPlainRelativePath(url) && !/[\s()<>]/.test(url));
}

export function renderCiSummary(input: ReportInput, options: { artifactUrl?: string } = {}): string {
  const i = safe(input);
  const confirmed = i.findings.filter((f) => f.certainty === 'confirmed').length;
  const suspected = i.findings.filter((f) => f.certainty === 'suspected').length;
  const unknownClaims = i.claims.filter((c) =>
    ['unknown', 'timeout', 'unsupported'].includes(c.status),
  ).length;
  return `## Veritas\n\n- Verdict: ${i.run.verdict ?? 'unknown'}\n- Exit code: ${i.run.exitCode ?? 'unknown'}\n- Findings: ${confirmed.toLocaleString('en-US')} confirmed, ${suspected.toLocaleString('en-US')} suspected\n- Formal claims requiring follow-up: ${unknownClaims.toLocaleString('en-US')}\n- Finding details truncated to counts to keep this summary under 65,000 characters.${options.artifactUrl && safeReportUrl(options.artifactUrl) ? `\n- [Full report](${options.artifactUrl})` : ''}\n`;
}
