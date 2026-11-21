#!/usr/bin/env node
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeFor, loadConfig, redact, resolveInsideRoot, runCommand } from '@under18dev/veritas-core';
import {
  bundledTools,
  detectProject,
  PROFILE_STAGES,
  type Profile,
  runDoctor,
  runVeritas,
  testRunnerFor,
} from '@under18dev/veritas-engine';
import { planFromEvent, type RunPlan } from './event.js';

const input = (name: string, fallback: string): string =>
  process.env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`] || fallback;

export async function changedFiles(root: string, since: string | null): Promise<string[] | null> {
  if (!since) return null;
  const result = await runCommand('git', ['diff', '--name-only', `${since}...HEAD`], {
    cwd: root,
    timeoutMs: 10_000,
  });

  if (result.exitCode !== 0 || result.spawnError || result.timedOut) return null;

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function docsOnly(files: string[]): boolean {
  return (
    files.length > 0 &&
    files.every((file) => /^(docs\/|.*\.md$|.*\.(png|jpe?g|gif|svg|webp|bmp|ico)$)/i.test(file))
  );
}

function writeOutput(values: Record<string, string>): void {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${redact(value)}`)
        .join('\n')}\n`,
    );
}

function degraded(reason: string, behavior: string, fromFork: boolean): number {
  const exitCode = behavior === 'fail' ? 4 : 0;
  writeOutput({
    verdict: 'inconclusive',
    'exit-code': String(exitCode),
    'run-id': '',
    'confirmed-findings': '0',
    'report-path': '',
    'from-fork': String(fromFork),
  });

  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Veritas\n\nDegraded: ${redact(reason)}.\n`);

  return exitCode;
}

export async function main(): Promise<number> {
  // The working directory must stay inside the checked-out repository; `../..` or an absolute path elsewhere
  // would analyse and write .veritas/ outside it.
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const root = resolveInsideRoot(workspace, input('working-directory', '.'));
  let event: RunPlan;

  try {
    event = planFromEvent({
      eventName: process.env.GITHUB_EVENT_NAME,
      eventPath: process.env.GITHUB_EVENT_PATH,
      repository: process.env.GITHUB_REPOSITORY,
      baseRef: process.env.GITHUB_BASE_REF,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('refusing privileged GitHub event')) return 2;
    throw error;
  }
  const since = input('since', '') || event.since;
  const files = await changedFiles(root, since);

  if (files && docsOnly(files)) {
    writeOutput({
      verdict: 'skipped',
      'exit-code': '0',
      'run-id': '',
      'confirmed-findings': '0',
      'report-path': '',
      'from-fork': String(event.fromFork),
    });

    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Veritas\n\nSkipped: documentation-only change.\n');

    return 0;
  }
  // An explicit input wins; an empty one (the default) uses the configured policy, then 'warn'.
  const configured = await loadConfig(root).catch(() => null);
  const project = detectProject(root, configured?.config ?? null);
  const runner = testRunnerFor(configured?.config);
  const behaviorInput =
    process.env.INPUT_INCONCLUSIVE || (configured?.config.policy.inconclusiveBehavior ?? 'warn');

  if (!project.hasPackageJson) return degraded('no package.json found', behaviorInput, event.fromFork);
  const doctor = await runDoctor(root, configured?.config ?? null, process.env, bundledTools());

  if (!doctor.capabilities.some((cap) => cap.name === runner.name && cap.state !== 'unavailable'))
    return degraded(`${runner.displayName} is unavailable`, behaviorInput, event.fromFork);
  const profile = input('profile', 'standard') as Profile;

  if (!PROFILE_STAGES[profile]) throw new Error(`unsupported profile: ${profile}`);
  const behavior = behaviorInput as 'warn' | 'fail' | 'ignore';
  const summary = await runVeritas({
    root,
    command: 'github-action',
    stages: PROFILE_STAGES[profile],
    profile,
    offline: true,
    ...(since ? { since } : {}),
  });
  const decision =
    behavior === 'fail' && summary.decision.reasons.some((reason) => reason.includes('inconclusive'))
      ? { ...summary.decision, verdict: 'inconclusive' as const, exitCode: 4 as const }
      : summary.decision;
  // Workspace-relative POSIX path of the run's run.json (the run directory holds the reports), the same on every
  // runner OS and usable in later workflow steps.
  const reportPath = path.relative(workspace, path.join(summary.dir, 'run.json')).split(path.sep).join('/');
  writeOutput({
    verdict: decision.verdict,
    'exit-code': String(decision.exitCode),
    'run-id': summary.runId,
    'confirmed-findings': String(summary.findings.filter((f) => f.certainty === 'confirmed').length),
    'report-path': reportPath,
    'from-fork': String(event.fromFork),
  });

  if (process.env.GITHUB_STEP_SUMMARY && input('summary', 'true') !== 'false') {
    const counts = summary.findings.reduce<Record<string, number>>((out, finding) => {
      out[finding.certainty] = (out[finding.certainty] ?? 0) + 1;

      return out;
    }, {});
    const findings =
      summary.findings
        .slice(0, 20)
        .map((f) => `- ${f.id} (${f.certainty}): ${f.title}`)
        .join('\n') || '- none';
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      redact(
        `# Veritas\n\n- Verdict: **${decision.verdict}**\n- Exit code: **${decision.exitCode}**\n- Run ID: \`${summary.runId}\`\n${event.fromFork ? '- Pull request from a fork: yes\n' : ''}- Findings by certainty: ${JSON.stringify(counts)}\n\n## Findings\n${findings}\n\nRun \`veritas explain <finding-id>\` locally for details.\n`,
      ).slice(0, 60_000),
    );
  }

  return decision.exitCode;
}

// Run when started directly or through the package's bin link (node_modules/.bin, npx), which resolves to this file.
const started = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : '';
  } catch {
    return '';
  }
})();

if (started && started === realpathSync(fileURLToPath(import.meta.url)))
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(redact(error instanceof Error ? error.message : String(error)));
      // The shared exit codes: 2 only for a user error (bad input or configuration), 3 for tool failures.
      process.exitCode = exitCodeFor(error);
    });
