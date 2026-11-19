import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EvidenceSource,
  Finding,
  FormalClaim,
  Mutant,
  Property,
  Run,
  redactDeep,
  TestAssessment,
  TestCase,
  TestPropertyEdge,
} from '@veritas/core';
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
const Conflict = z.object({
  id: z.string().min(1),
  symbol: z.string(),
  param: z.string(),
  propertyIds: z.array(z.string()),
  preferredPropertyId: z.string().nullable(),
  rationale: z.array(z.string()),
});

export const ReportInput = z.object({
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
  artifactBase: z.string(),
});
export type ReportInput = z.infer<typeof ReportInput>;
export type ReportStatement = z.infer<typeof Statement>;
export type SarifLog = {
  version: '2.1.0';
  $schema: string;
  runs: Array<{ tool: { driver: { name: string; rules: unknown[] } }; results: unknown[] }>;
};

const ReportDocument = z.object({
  schemaVersion: z.literal('1.0.0'),
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
    ? `, solver input ${artifactBase.replace(/\/$/, '')}/${claim.solverInputArtifact}`
    : '';
  return `${claim.kind}: ${statusText(claim.status)}${domain}; assurance ${claim.assurance}; scope ${scope}; assumptions ${claim.assumptions.join('; ') || 'none'}; semantic gaps ${claim.semanticGaps.join('; ') || 'none'}; counterexample ${claim.counterexample ? JSON.stringify(claim.counterexample) : 'none'}${artifact}; reproduction ${claim.reproduction ?? 'none'}`;
}

function sections(input: ReportInput): string[] {
  const i = safe(input);
  const run = i.run;
  const props = (status: string[]) => i.properties.filter((p) => status.includes(p.status));
  const mutationGroups = ['killed', 'survived', 'equivalent_proven', 'other'].map((group) => {
    const members = i.mutants.filter((m) =>
      group === 'other'
        ? !['killed', 'survived', 'equivalent_proven'].includes(m.status)
        : m.status === group,
    );
    return `${group} (${members.length}): ${members.map((m) => `${m.id} ${m.original} -> ${m.replacement}`).join('; ') || 'none'}`;
  });
  return [
    `1. Run metadata/environment/scope\nrun ${run.id}; command ${run.command} ${run.args.join(' ')}; profile ${run.profile ?? 'none'}; git commit ${run.scope.since ?? 'not supplied'}; OS ${run.environment.os}; Node ${run.environment.node}; verdict ${run.verdict ?? 'none'}; exit code ${run.exitCode ?? 'none'}; scope ${run.scope.root} (${run.scope.paths.join(', ') || 'all'}); policy reasons ${run.policyReasons.join('; ') || 'none'}`,
    `2. Collected evidence with provenance\n${
      i.sources
        .map(
          (s) =>
            `${s.id}: ${s.kind} ${s.locator}${s.range ? `:${s.range.start}` : ''} — ${s.summary}${i.statements
              .filter((statement) => statement.sourceId === s.id)
              .map((statement) => `; quote ${statement.quote}`)
              .join('')}`,
        )
        .join('\n') || 'none'
    }`,
    `3. Property ledger\naccepted: ${
      props(['accepted'])
        .map((p) => `${p.id} (${p.origin})`)
        .join(', ') || 'none'
    }\nproposed: ${
      props(['proposed'])
        .map((p) => `${p.id} (${p.origin})`)
        .join(', ') || 'none'
    }\nconflicted: ${
      props(['conflicted'])
        .map((p) => `${p.id} (${p.origin})`)
        .join(', ') || 'none'
    }\nother: ${
      props(['reviewed', 'rejected', 'superseded'])
        .map((p) => `${p.id} (${p.status}, ${p.origin})`)
        .join(', ') || 'none'
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
    `8. Test assessments\n${i.assessments.map((a) => `${a.testId}: ${a.outcome}; rationale ${a.rationale.join('; ')}; unknowns ${a.vector.unknowns.join('; ') || 'none'}`).join('\n') || 'none'}`,
    `9. Improvement proposals\nnone in this run`,
    `10. Limitations\n${[...run.stages.filter((s) => s.status !== 'succeeded').map((s) => `stage ${s.stage} was ${s.status}`), ...i.claims.filter((c) => ['unsupported', 'semantic_mismatch', 'timeout', 'unknown'].includes(c.status)).map((c) => `claim ${c.id} is ${c.status}`), ...i.properties.filter((p) => p.origin === 'inferred').map((p) => `property ${p.id} is inferred (not a specification)`)].join('; ') || 'none'}`,
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
  const body = sections(i)
    .map((s) => {
      const [title, ...rest] = s.split('\n');
      return `## ${title}\n\n${rest.join('\n')}`;
    })
    .join('\n\n');
  return `# Veritas report: ${i.run.id}\n\n${body.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n`;
}

/**
 * A link target for a run artifact, or null when it is not a plain relative path. Rejects any URL scheme
 * (`javascript:`, `data:`, `http:` ...), protocol-relative and absolute paths, and backslashes.
 */
export function safeArtifactHref(base: string, artifact: string): string | null {
  const joined = `${base.replace(/\/$/, '')}/${artifact}`;
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(joined) ||
    joined.startsWith('//') ||
    joined.startsWith('/') ||
    joined.includes('\\')
  )
    return null;
  if ([...joined].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  return joined;
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Veritas report ${htmlEscape(i.run.id)}</title><style>body{font-family:system-ui,sans-serif;line-height:1.45;max-width:1100px;margin:2rem auto;padding:0 1rem}article{border:1px solid #bbb;padding:.75rem;margin:.75rem 0}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.4rem;text-align:left}blockquote{white-space:pre-wrap}pre{white-space:pre-wrap}</style></head><body><h1>Veritas report</h1>${section('1. Run metadata/environment/scope', metadata, `<p>${htmlEscape(i.run.id)} — ${htmlEscape(i.run.verdict ?? 'none')} — ${htmlEscape(i.run.environment.os)} — Node ${htmlEscape(i.run.environment.node)}</p>`)}${section('2. Collected evidence with provenance', evidence, sources || '<p>none</p>')}${section('3. Property ledger', propertyLedger, properties || '<p>none</p>')}${section('4. Specification vs implementation mismatches', mismatches, findingBlocks || '<p>none</p>')}${section('5. Tests x properties matrix', matrix, `${table}${tests || '<p>none</p>'}`)}${section('6. Mutation outcomes', mutation, mutants || '<p>none</p>')}${section('7. Formal claims', formal, claims || '<p>none</p>')}${section('8. Test assessments', assessments, `<p>${htmlEscape(i.assessments.map((assessment) => `${assessment.testId}: ${assessment.outcome}; ${assessment.rationale.join('; ')}`).join('\n') || 'none')}</p>`)}${section('9. Improvement proposals', improvements, '<p>none in this run</p>')}${section('10. Limitations', limitations, `<p>${htmlEscape(limitations.replace(/^10\. Limitations\n/, ''))}</p>`)}</body></html>`;
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
          driver: { name: 'veritas', rules: kinds.map((id) => ({ id, shortDescription: { text: id } })) },
        },
        results: i.findings.map((f) => ({
          ruleId: f.kind,
          level: sarifLevel(f),
          message: { text: f.title },
          properties: f.certainty === 'suspected' ? { certainty: 'suspected' } : { certainty: f.certainty },
          locations: f.locations.length
            ? f.locations.map((l) => ({
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

export function renderCiSummary(input: ReportInput, options: { artifactUrl?: string } = {}): string {
  const i = safe(input);
  const confirmed = i.findings.filter((f) => f.certainty === 'confirmed').length;
  const suspected = i.findings.filter((f) => f.certainty === 'suspected').length;
  const unknownClaims = i.claims.filter((c) =>
    ['unknown', 'timeout', 'unsupported'].includes(c.status),
  ).length;
  return `## Veritas\n\n- Verdict: ${i.run.verdict ?? 'unknown'}\n- Exit code: ${i.run.exitCode ?? 'unknown'}\n- Findings: ${confirmed.toLocaleString('en-US')} confirmed, ${suspected.toLocaleString('en-US')} suspected\n- Formal claims requiring follow-up: ${unknownClaims.toLocaleString('en-US')}\n- Finding details truncated to counts to keep this summary under 65,000 characters.${options.artifactUrl ? `\n- [Full report](${options.artifactUrl})` : ''}\n`;
}
