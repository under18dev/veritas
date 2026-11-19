import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type Mutant,
  redact,
  redactDeep,
  resolveInsideRoot,
  runProjectTests,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import { detectMutator, PINNED_MUTATOR_VERSION, summarize } from './detect.js';
import { importMutationReport } from './import.js';
import { countMutants, emptyCounts, type MutationRunResult, type MutationRunStatus } from './schema.js';

export interface RunMutationOptions {
  root: string;
  config: VeritasConfig;
  /** Git ref: only mutants in `git diff <since>`. */
  since?: string;
  /** Source globs relative to the root, passed as `--include`. */
  scope?: string[];
  signal?: AbortSignal;
  /** Absolute directory (inside the run directory) where mutator writes `mutation.json`. */
  reportDir: string;
  killMatrix?: boolean;
  /** Mutant keys to run alone (`--only`). */
  only?: string[];
  /** Explicit mutator CLI script; by default it is resolved from the project, then from this adapter. */
  mutatorBin?: string;
  /** Do not fall back to the adapter's own mutator when the project has none (default false). */
  projectMutatorOnly?: boolean;
}

const MUTANT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Exit code mutator uses when the tests fail without any mutant. */
const EXIT_BASELINE_FAILED = 4;
/** Exit code for a quality gate configured in the project's mutator config. */
const EXIT_GATE_FAILED = 2;

/** Seconds after which mutator starts no new mutant: leave a quarter of the hard timeout to finish. */
export function timeBudgetSeconds(timeoutMs: number): number {
  return Math.max(1, Math.floor((timeoutMs * 0.75) / 1000));
}

/** Build the mutator argv (without the Node executable and script). Throws on unsafe input. */
export function buildMutatorArgs(options: RunMutationOptions): string[] {
  const args = ['--root', path.resolve(options.root), '--reporter', 'json', '--reporter', 'agent'];
  args.push('--report-dir', options.reportDir);
  if (options.since !== undefined) {
    if (options.since === '' || options.since.startsWith('-') || /[\s\0]/.test(options.since)) {
      throw new TypeError(`invalid git ref for --since: ${JSON.stringify(options.since)}`);
    }
    args.push('--since', options.since);
  }
  for (const glob of options.scope ?? []) {
    if (
      glob === '' ||
      glob.startsWith('-') ||
      glob.includes('\0') ||
      path.isAbsolute(glob) ||
      /^[A-Za-z]:/.test(glob) ||
      glob.split(/[\\/]/).includes('..')
    ) {
      throw new TypeError(`scope glob must be relative to the project root: ${JSON.stringify(glob)}`);
    }
    args.push('--include', glob);
  }
  if (options.killMatrix) args.push('--kill-matrix');
  for (const key of options.only ?? []) {
    if (!MUTANT_KEY.test(key)) throw new TypeError(`invalid mutant key for --only: ${JSON.stringify(key)}`);
    args.push('--only', key);
  }
  args.push('--time-budget', String(timeBudgetSeconds(options.config.mutation.timeoutMs)));
  return args;
}

/**
 * Resolve `reportDir` and require it to be strictly inside `root` (symlinks included).
 * Throws VeritasError `REPORT_DIR_OUTSIDE_ROOT` otherwise.
 */
function confineReportDir(root: string, reportDir: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(reportDir));
  let resolved: string | null = null;
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    try {
      resolved = resolveInsideRoot(root, relative);
    } catch {
      resolved = null;
    }
  }
  if (resolved === null) {
    throw new VeritasError(
      'user',
      'REPORT_DIR_OUTSIDE_ROOT',
      `reportDir must be a directory inside the project root: ${reportDir}`,
    );
  }
  return resolved;
}

/** Run mutator on the project and normalize its report. Every non-success outcome is reported as such. */
export async function runMutation(options: RunMutationOptions): Promise<MutationRunResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const result = (
    status: MutationRunStatus,
    fields: Partial<MutationRunResult> & { detail: string | null },
  ): MutationRunResult => ({
    status,
    backend: { name: 'mizchi', version: null },
    command: [],
    exitCode: null,
    durationMs: Date.now() - started,
    mutants: [],
    counts: emptyCounts(),
    rawReportPath: null,
    agentReport: null,
    killMatrix: null,
    warnings,
    ...fields,
  });

  if (!path.isAbsolute(options.reportDir)) {
    return result('error', { detail: `reportDir must be an absolute path: ${options.reportDir}` });
  }
  // Checked before anything is created or spawned: mutator writes wherever --report-dir points.
  const reportDir = confineReportDir(options.root, options.reportDir);
  let args: string[];
  try {
    args = buildMutatorArgs({ ...options, reportDir });
  } catch (error) {
    return result('error', { detail: (error as Error).message });
  }
  if (options.signal?.aborted) return result('cancelled', { detail: 'aborted before mutator started' });

  const detection = await detectMutator(options.root, {
    ...(options.mutatorBin === undefined ? {} : { binPath: options.mutatorBin }),
    fallbackToAdapter: !options.projectMutatorOnly,
  });
  const backend = { name: 'mizchi' as const, version: detection.version };
  if (!detection.available || detection.binPath === null) {
    return result('unsupported', { backend, detail: detection.detail });
  }
  if (detection.origin === 'adapter') {
    warnings.push(`the project has no @mizchi/mutator; using the adapter's own copy at ${detection.binPath}`);
  }
  if (detection.version !== PINNED_MUTATOR_VERSION) {
    warnings.push(
      `mutator ${detection.version ?? 'of unknown version'} differs from the pinned ${PINNED_MUTATOR_VERSION}`,
    );
  }
  const needed = [
    options.since !== undefined && '--since',
    (options.scope?.length ?? 0) > 0 && '--include',
    options.killMatrix && '--kill-matrix',
    (options.only?.length ?? 0) > 0 && '--only',
    '--time-budget',
    'agent',
    'json',
  ].filter((f): f is string => typeof f === 'string');
  const missing = needed.filter((flag) => !detection.capabilities.includes(flag));
  if (missing.length > 0) {
    return result('unsupported', {
      backend,
      detail: `mutator ${detection.version ?? ''} does not support: ${missing.join(', ')}`,
    });
  }
  if (options.config.mutation.mode === 'diff' && options.since === undefined) {
    warnings.push('mutation.mode is "diff" but no --since ref was given: all mutants in scope were run');
  }

  mkdirSync(reportDir, { recursive: true });
  const command = [process.execPath, detection.binPath, ...args];
  const run = await runProjectTests(process.execPath, [detection.binPath, ...args], {
    cwd: options.root,
    timeoutMs: options.config.mutation.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const reportPath = path.join(reportDir, 'mutation.json');
  const rawReportPath = existsSync(reportPath) ? reportPath : null;
  const common = { backend, command, exitCode: run.exitCode, durationMs: run.durationMs, rawReportPath };

  if (run.spawnError)
    return result('error', { ...common, detail: `could not start mutator: ${run.spawnError}` });
  if (run.timedOut) {
    return result('timeout', {
      ...common,
      detail: `mutator exceeded mutation.timeoutMs (${options.config.mutation.timeoutMs} ms) and was killed`,
    });
  }
  if (options.signal?.aborted)
    return result('cancelled', { ...common, detail: 'aborted while mutator was running' });
  if (run.exitCode === EXIT_BASELINE_FAILED) {
    return result('failed', {
      ...common,
      detail: `tests fail without mutants (baseline, exit 4): ${summarize(redact(run.stderr))}`,
    });
  }
  if (run.exitCode !== 0 && run.exitCode !== EXIT_GATE_FAILED) {
    return result('error', {
      ...common,
      detail: `mutator exited with ${run.exitCode ?? `signal ${run.signal}`}: ${summarize(redact(run.stderr))}`,
    });
  }
  if (run.exitCode === EXIT_GATE_FAILED) {
    warnings.push('a quality gate in the project mutator config failed (exit 2); results are reported as-is');
  }

  let agentReport: unknown = null;
  try {
    agentReport = redactDeep(JSON.parse(run.stdout) as unknown);
  } catch {
    warnings.push(`the agent report on stdout is not JSON: ${summarize(redact(run.stdout), 3, 300)}`);
  }
  const agent = agentReport as {
    gaps?: { key?: unknown; childProcess?: unknown }[];
    killMatrix?: unknown;
  } | null;
  const childProcessKeys = new Set(
    (Array.isArray(agent?.gaps) ? agent.gaps : [])
      .filter((g) => g?.childProcess === true && typeof g.key === 'string')
      .map((g) => g.key as string),
  );

  if (rawReportPath === null) {
    return result('error', { ...common, agentReport, detail: `mutator did not write ${reportPath}` });
  }
  let mutants: Mutant[];
  try {
    const json: unknown = JSON.parse(readFileSync(rawReportPath, 'utf8'));
    mutants = importMutationReport(json, { root: options.root, source: 'mutator', childProcessKeys });
  } catch (error) {
    return result('error', {
      ...common,
      agentReport,
      detail: `could not parse ${rawReportPath}: ${redact((error as Error).message)}`,
    });
  }
  if (options.killMatrix && agent?.killMatrix === undefined) {
    warnings.push('--kill-matrix was requested but the agent report has no killMatrix');
  }
  const counts = countMutants(mutants);
  if (counts.pending > 0) {
    warnings.push(
      `${counts.pending} mutant(s) are pending (not run: outside --since, or over the time budget)`,
    );
  }
  return result('succeeded', {
    ...common,
    mutants,
    counts,
    agentReport,
    killMatrix: agent?.killMatrix ?? null,
    detail: null,
  });
}

/**
 * Normalize an existing mutation-testing-elements (schemaVersion 2) report, such as one written by Stryker,
 * instead of running mutator. The file must be inside the project. Survivors stay `survived`.
 */
export function importMutationResult(options: { root: string; reportFile: string }): MutationRunResult {
  const file = resolveInsideRoot(options.root, options.reportFile);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new VeritasError(
      'user',
      'MUTATION_REPORT_UNREADABLE',
      `cannot read mutation report ${options.reportFile}: ${redact((error as Error).message)}`,
    );
  }
  let mutants: Mutant[];
  try {
    mutants = importMutationReport(json, { root: options.root, source: 'mutation-testing-elements' });
  } catch (error) {
    throw new VeritasError('user', 'MUTATION_REPORT_INVALID', (error as Error).message);
  }
  const framework = (json as { framework?: { name?: unknown; version?: unknown } }).framework;
  const counts = countMutants(mutants);
  return {
    status: 'succeeded',
    detail: null,
    backend: { name: 'imported', version: typeof framework?.version === 'string' ? framework.version : null },
    command: [],
    exitCode: null,
    durationMs: 0,
    mutants,
    counts,
    rawReportPath: file,
    agentReport: null,
    killMatrix: null,
    warnings: [
      `imported ${mutants.length} mutant(s) from ${options.reportFile}${typeof framework?.name === 'string' ? ` (${framework.name})` : ''}; mutation testing was not run`,
      ...(counts.pending > 0 ? [`${counts.pending} mutant(s) in the report are pending`] : []),
    ],
  };
}
