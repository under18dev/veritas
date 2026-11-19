import {
  ExitCode as Exit,
  type ExitCode,
  redact,
  type StageName,
  VeritasError,
} from '@under18dev/veritas-core';
import {
  buildReportInput,
  decideProperty,
  diffLatest,
  explainFinding,
  generateTests,
  listProperties,
  PROFILE_STAGES,
  type Profile,
  type ReportFormat,
  type RunSummary,
  readArtifact,
  readLatest,
  renderReport,
  runVeritas,
  showProperty,
} from '@under18dev/veritas-engine';
import { emitJson, emitText, type GlobalOptions, log } from '../output.js';
import { formatRunText } from '../text.js';

type Opts = GlobalOptions & Record<string, unknown>;

function summaryOut(opts: Opts, summary: RunSummary): ExitCode {
  if (opts.json) {
    emitJson({
      status: summary.decision.verdict,
      exitCode: summary.decision.exitCode,
      runId: summary.runId,
      dir: summary.dir,
      reasons: summary.decision.reasons,
      stages: summary.run.stages.map((s) => ({ stage: s.stage, status: s.status, messages: s.messages })),
      findings: summary.findings,
    });
  } else {
    emitText(formatRunText(summary));
  }
  return summary.decision.exitCode;
}

async function stagesCommand(
  opts: Opts,
  command: string,
  stages: StageName[],
  extra: Partial<Parameters<typeof runVeritas>[0]> = {},
) {
  const summary = await runVeritas({
    root: opts.root,
    command,
    args: process.argv.slice(2),
    stages,
    allowCodeConfig: Boolean(opts.allowCodeConfig),
    log,
    ...extra,
  });
  return summaryOut(opts, summary);
}

export function discoverCommand(opts: Opts): Promise<ExitCode> {
  const sources = String(opts.sources ?? 'local');
  if (opts.offline && /github|web|all/.test(sources)) log('note: --offline overrides network sources');
  return stagesCommand(opts, 'discover', ['discover'], {
    offline: Boolean(opts.offline),
    localSourcesOnly: !/github|web|all/.test(sources),
  });
}

export function analyzeCommand(opts: Opts, args: string[]): Promise<ExitCode> {
  return stagesCommand(opts, 'analyze', ['index', 'discover', 'spec', 'map', 'assess'], {
    offline: true,
    ...(args[0] ? { scope: [args[0]] } : {}),
    ...(opts.since ? { since: String(opts.since) } : {}),
  });
}

export function mutateCommand(opts: Opts): Promise<ExitCode> {
  return stagesCommand(opts, 'mutate', ['index', 'discover', 'spec', 'map', 'mutate', 'assess'], {
    offline: true,
    ...(opts.since ? { since: String(opts.since) } : {}),
    ...(opts.scope ? { scope: [String(opts.scope)] } : {}),
  });
}

export function proveCommand(opts: Opts): Promise<ExitCode> {
  return stagesCommand(opts, 'prove', ['index', 'discover', 'spec', 'map', 'prove', 'assess', 'report'], {
    offline: true,
    includeProposed: Boolean(opts.includeProposed),
    formalEngine: opts.engine === 'lean' ? 'lean' : 'z3',
    ...(opts.property ? { propertyIds: [String(opts.property)] } : {}),
  });
}

export function runCommandCli(opts: Opts): Promise<ExitCode> {
  const profile = (opts.profile as Profile | undefined) ?? 'standard';
  return stagesCommand(opts, 'run', PROFILE_STAGES[profile], {
    profile,
    offline: Boolean(opts.offline),
    includeProposed: Boolean(opts.includeProposed),
    ...(opts.since ? { since: String(opts.since) } : {}),
  });
}

export async function replayCommand(opts: Opts, args: string[]): Promise<ExitCode> {
  const runId = args[0] as string;
  const { data: run } = readArtifact(opts.root, runId, 'run');
  log(`replaying ${run.command} from ${runId} (${run.args.join(' ')})`);
  const summary = await runVeritas({
    root: opts.root,
    command: run.command,
    args: run.args,
    stages: run.stages.map((s) => s.stage),
    ...(run.profile ? { profile: run.profile } : {}),
    offline: true,
    includeProposed: run.args.includes('--include-proposed'),
    ...(run.scope.since ? { since: run.scope.since } : {}),
    allowCodeConfig: Boolean(opts.allowCodeConfig),
    log,
  });
  return summaryOut(opts, summary);
}

export async function reportCommand(opts: Opts): Promise<ExitCode> {
  const format = String(opts.format ?? (opts.json ? 'json' : 'text')) as ReportFormat;
  const runId = typeof opts.run === 'string' ? opts.run : undefined;
  const input = buildReportInput(
    opts.root,
    runId,
    runId ? '.' : `.veritas/runs/${readLatest(opts.root, 'run').runId}`,
  );
  process.stdout.write(redact(renderReport(input, format)));
  if (format === 'text' || format === 'markdown') process.stdout.write('\n');
  return Exit.Success;
}

export async function explainCommand(opts: Opts, args: string[]): Promise<ExitCode> {
  const explanation = explainFinding(opts.root, args[0] as string);
  if (opts.json) {
    emitJson(explanation);
    return Exit.Success;
  }
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
      lines.push(`        smt: .veritas/runs/${explanation.runId}/${c.solverInputArtifact}`);
  }
  lines.push('', ...f.nextActions.map((a) => `next: ${a}`));
  emitText(lines.join('\n'));
  return Exit.Success;
}

export async function specCommand(opts: Opts, sub: string, args: string[]): Promise<ExitCode> {
  switch (sub) {
    case 'list': {
      const { runId, properties } = listProperties(opts.root);
      if (opts.json) emitJson({ runId, properties });
      else
        for (const p of properties)
          emitText(`${p.id}  ${p.status.padEnd(10)} ${p.origin.padEnd(9)} ${p.description}`);
      return Exit.Success;
    }
    case 'show': {
      const result = showProperty(opts.root, args[0] as string);
      opts.json ? emitJson(result) : emitText(JSON.stringify(result, null, 2));
      return Exit.Success;
    }
    case 'accept':
    case 'reject': {
      if (typeof opts.reason !== 'string') {
        throw new VeritasError(
          'user',
          'APPROVAL_REASON',
          `spec ${sub} needs --reason`,
          `veritas spec ${sub} <id> --reason "<why>"`,
        );
      }
      const approval = await decideProperty(opts.root, args[0] as string, sub, {
        reason: opts.reason,
        ...(typeof opts.actor === 'string' ? { actor: opts.actor } : {}),
      });
      opts.json
        ? emitJson({ status: 'recorded', approval })
        : emitText(`recorded ${sub} of ${approval.propertyId} by ${approval.actor}`);
      return Exit.Success;
    }
    case 'diff': {
      const result = diffLatest(opts.root);
      if (opts.json) emitJson(result);
      else {
        emitText(`properties ${result.from ?? '(none)'} -> ${result.to}`);
        for (const p of result.diff.added) emitText(`+ ${p.id} ${p.description}`);
        for (const p of result.diff.removed) emitText(`- ${p.id} ${p.description}`);
        for (const c of result.diff.changed) emitText(`~ ${c.after.id} changed: ${c.fields.join(', ')}`);
        for (const s of result.diff.statusChanged) emitText(`* ${s.id} ${s.from} -> ${s.to}`);
      }
      return Exit.Success;
    }
    case 'export': {
      emitJson(listProperties(opts.root));
      return Exit.Success;
    }
    default:
      throw new VeritasError('user', 'UNKNOWN_SUBCOMMAND', `unknown spec subcommand ${sub}`);
  }
}

export async function testGenerateCommand(opts: Opts): Promise<ExitCode> {
  const generated = await generateTests(opts.root, {
    ...(typeof opts.property === 'string' ? { propertyId: opts.property } : {}),
    dryRun: Boolean(opts.dryRun),
    force: Boolean(opts.force),
    allowCodeConfig: Boolean(opts.allowCodeConfig),
  });
  if (opts.json) emitJson({ status: opts.dryRun ? 'dry_run' : 'written', generated });
  else if (opts.dryRun) for (const g of generated) emitText(`// ${g.file}\n${g.content}`);
  else
    for (const g of generated)
      emitText(`wrote ${g.file}${g.experimental ? ' (experimental: property not accepted)' : ''}`);
  if (generated.length === 0) log('no formalized property to generate tests for');
  return Exit.Success;
}
