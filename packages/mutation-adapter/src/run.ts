import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  MUTATOR_DECLARED_VITEST_MAJOR,
  MUTATOR_MIN_VITEST_MAJOR,
  type Mutant,
  redact,
  redactDeep,
  resolveInsideRoot,
  resolvePackageVersion,
  runProjectTests,
  type VeritasConfig,
  VeritasError,
  vitestMajor,
} from '@under18dev/veritas-core';
import { detectMutator, PINNED_MUTATOR_VERSION, summarize } from './detect.js';
import {
  baselineFailure,
  errorExcerpt,
  instrumentationFailures,
  isRelativeGlob,
  listSome,
  transformErrorLine,
  withoutDebug,
} from './diagnose.js';
import { importMutationReport } from './import.js';
import { countMutants, emptyCounts, type MutationRunResult, type MutationRunStatus } from './schema.js';
import { mutatorVitestDir, projectViteUrl, writeMutationVitestConfig } from './vitest-config.js';

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
  /**
   * Test files (POSIX, relative to the root) that can kill these mutants. When given, mutator runs only
   * them, through a generated Vitest config; an empty list means no test reaches the code in scope.
   */
  testFiles?: string[];
  /** Vitest config passed as `--config`. */
  configPath?: string;
  /** Pass `--no-typecheck`. */
  noTypecheck?: boolean;
  /** Source files (relative to the root, no glob characters) passed as `--exclude`. */
  exclude?: string[];
}

const MUTANT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Exit code mutator uses when the tests fail without any mutant. */
const EXIT_BASELINE_FAILED = 4;
/** Exit code for a quality gate configured in the project's mutator config. */
const EXIT_GATE_FAILED = 2;
/** At most this many files are left out to run mutator again; more points at something else than a parser bug. */
const MAX_EXCLUDED_FILES = 5;
/** The second run needs at least this much of mutation.timeoutMs left, and at least this share of it. */
const MIN_RETRY_MS = 30_000;
const MIN_RETRY_SHARE = 0.1;

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
    if (!isRelativeGlob(glob)) {
      throw new TypeError(`scope glob must be relative to the project root: ${JSON.stringify(glob)}`);
    }
    args.push('--include', glob);
  }

  for (const file of options.exclude ?? []) {
    if (!isRelativeGlob(file)) {
      throw new TypeError(`excluded file must be relative to the project root: ${JSON.stringify(file)}`);
    }
    args.push('--exclude', file);
  }

  if (options.configPath !== undefined) args.push('--config', options.configPath);

  if (options.noTypecheck) args.push('--no-typecheck');

  if (options.killMatrix) args.push('--kill-matrix');

  for (const key of options.only ?? []) {
    if (!MUTANT_KEY.test(key)) throw new TypeError(`invalid mutant key for --only: ${JSON.stringify(key)}`);
    args.push('--only', key);
  }
  args.push('--time-budget', String(timeBudgetSeconds(options.config.mutation.timeoutMs)));

  return args;
}

/**
 * True when `<root>/tsconfig.json` lists no files itself and only references other projects. mutator
 * type-checks mutants against exactly that file, and with no files in it every check fails.
 */
export function rootTsconfigHasNoFiles(root: string): boolean {
  let text: string;

  try {
    text = readFileSync(path.join(root, 'tsconfig.json'), 'utf8');
  } catch {
    return false;
  }
  // tsconfig allows comments and trailing commas; strip them outside strings.
  const json = text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ''))
    .replace(/,(\s*[}\]])/g, '$1');

  try {
    const config = JSON.parse(json) as Record<string, unknown>;

    return (
      Array.isArray(config.files) &&
      config.files.length === 0 &&
      config.include === undefined &&
      config.extends === undefined &&
      Array.isArray(config.references) &&
      config.references.length > 0
    );
  } catch {
    return false;
  }
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
  /** Source files mutator was run again without, after their instrumented copy failed to parse. */
  let excluded: string[] = [];
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
    ...(excluded.length > 0 ? { excludedFiles: excluded } : {}),
    ...fields,
  });

  if (!path.isAbsolute(options.reportDir)) {
    return result('error', { detail: `reportDir must be an absolute path: ${options.reportDir}` });
  }
  // Checked before anything is created or spawned: mutator writes wherever --report-dir points.
  const reportDir = confineReportDir(options.root, options.reportDir);
  const noTypecheck = options.noTypecheck ?? rootTsconfigHasNoFiles(options.root);

  if (noTypecheck && options.noTypecheck === undefined)
    warnings.push(
      'tsconfig.json at the root only references other projects, and mutator type-checks against that file alone: mutants were not type-checked, so some survivors may be type errors',
    );

  const vitest = resolvePackageVersion(options.root, 'vitest');
  const major = vitestMajor(vitest);

  if (major !== null && major < MUTATOR_MIN_VITEST_MAJOR)
    return result('unsupported', {
      detail: `mutation testing needs Vitest ${MUTATOR_MIN_VITEST_MAJOR} or later; the project has Vitest ${vitest}`,
    });

  if (major !== null && major < MUTATOR_DECLARED_VITEST_MAJOR)
    warnings.push(
      `@mizchi/mutator declares Vitest ${MUTATOR_DECLARED_VITEST_MAJOR}; the project has Vitest ${vitest}, which has worked but is outside that range`,
    );

  if (options.testFiles?.length === 0) {
    warnings.push('no test imports the code in scope; mutation was not run');

    return result('succeeded', { detail: 'no test can kill these mutants' });
  }
  let args: string[];

  try {
    args = buildMutatorArgs({ ...options, reportDir, noTypecheck });
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

  // The adapter's copy runs the project's Vitest, but Vitest loads mutator's setup file from where Veritas is
  // installed, outside the project; that is allowed below, and anything else loaded from there may still fail.
  const ownCopyHint =
    "the project has no @mizchi/mutator, so the copy bundled with Veritas ran the project's Vitest with files from outside the project; if the first error names such a file, add @mizchi/mutator to the project's devDependencies";
  const fsAllowDir = detection.origin === 'adapter' ? mutatorVitestDir(detection.binPath) : null;
  const writesConfig = options.testFiles !== undefined || fsAllowDir !== null;

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
    writesConfig && '--config',
    noTypecheck && '--[no-]typecheck',
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
    warnings.push(
      'mutation.mode is "diff", but this run had no --since ref, so every mutant in scope was run; pass --since <ref> (for example --since origin/main) to mutate only the code changed since that ref',
    );
  }

  mkdirSync(reportDir, { recursive: true });
  let configPath: string | undefined;

  if (writesConfig) {
    configPath = writeMutationVitestConfig({
      root: options.root,
      dir: reportDir,
      ...(options.testFiles === undefined ? {} : { testFiles: options.testFiles }),
      ...(fsAllowDir === null
        ? {}
        : { fsAllow: { dirs: [fsAllowDir], viteUrl: projectViteUrl(options.root) } }),
    });
  }
  const binPath = detection.binPath;
  const argsExcluding = (exclude: string[], timeoutMs = options.config.mutation.timeoutMs) =>
    buildMutatorArgs({
      ...options,
      // The time budget of a second run is computed from what is left of the timeout.
      config: { ...options.config, mutation: { ...options.config.mutation, timeoutMs } },
      reportDir,
      noTypecheck,
      ...(configPath === undefined ? {} : { configPath }),
      ...(exclude.length > 0 ? { exclude } : {}),
    });
  const spawn = (argv: string[], timeoutMs = options.config.mutation.timeoutMs) =>
    runProjectTests(process.execPath, [binPath, ...argv], {
      cwd: options.root,
      timeoutMs,
      memoryMb: options.config.limits.memoryMb,
      // mutator logs why a test file failed to load only to this debug channel, and only when one does.
      env: { NODE_DEBUG: 'mutator' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const reportPath = path.join(reportDir, 'mutation.json');
  const ran = (run: Awaited<ReturnType<typeof spawn>>, argv: string[], durationMs: number) => ({
    backend,
    command: [process.execPath, binPath, ...argv],
    exitCode: run.exitCode,
    durationMs,
    rawReportPath: existsSync(reportPath) ? reportPath : null,
  });
  const adapterHint = detection.origin === 'adapter' ? `; ${ownCopyHint}` : '';
  args = argsExcluding([]);
  let run = await spawn(args);
  let durationMs = run.durationMs;

  // A baseline can fail because the bundler cannot parse mutator's instrumented copy of a source file, which is
  // not a test failure. Run once more without the files the error names, within what is left of the timeout. If
  // that run passes the baseline, the instrumentation was at fault and a warning says so; otherwise the failure
  // of that run is reported, never hidden.
  if (run.exitCode === EXIT_BASELINE_FAILED && !run.timedOut && !options.signal?.aborted) {
    const stderr = redact(run.stderr);
    const detect = (text: string) =>
      instrumentationFailures(text, options.root, {
        testInclude: options.config.analysis.testInclude,
        ...(options.testFiles === undefined ? {} : { testFiles: options.testFiles }),
        include: options.scope?.length ? options.scope : options.config.analysis.include,
        exclude: options.config.analysis.exclude,
      });
    const broken = detect(stderr);

    if (broken.length > 0) {
      const list = listSome(broken);
      const parseError = transformErrorLine(stderr);
      const diagnosis = `instrumentation failed: the project's bundler could not parse mutator's instrumented copy of ${list} (${parseError}). If the file loads in your own test run, this is usually a bug in the bundler's parser, and upgrading Vite (or rolldown and oxc) may fix it.\n${baselineFailure(stderr, options.root)}`;
      const timeoutMs = options.config.mutation.timeoutMs;
      const remainingMs = timeoutMs - run.durationMs;
      const notRetried = !detection.capabilities.includes('--exclude')
        ? `this mutator has no --exclude, so it was not run again without ${list}`
        : broken.length > MAX_EXCLUDED_FILES
          ? `${broken.length} files are named, more than the ${MAX_EXCLUDED_FILES} Veritas leaves out, so mutator was not run again`
          : remainingMs < MIN_RETRY_MS || remainingMs < timeoutMs * MIN_RETRY_SHARE
            ? `too little of mutation.timeoutMs (${timeoutMs} ms) was left to run mutator again without ${list}; raise mutation.timeoutMs or narrow the run with --since`
            : null;

      if (notRetried !== null) {
        return result('error', { ...ran(run, args, durationMs), detail: `${diagnosis}\n${notRetried}` });
      }
      const retryArgs = argsExcluding(broken, remainingMs);
      rmSync(reportPath, { force: true });
      const retry = await spawn(retryArgs, remainingMs);
      durationMs += retry.durationMs;
      const retried = `mutator ran again without ${list}, because its instrumented copy did not parse (${parseError})`;
      const retryFailed = !retry.timedOut && !retry.spawnError && !options.signal?.aborted;

      if (retryFailed && retry.exitCode === EXIT_BASELINE_FAILED) {
        const retryStderr = redact(retry.stderr);
        const still = detect(retryStderr).filter((file) => broken.includes(file));

        return result('failed', {
          ...ran(retry, retryArgs, durationMs),
          detail:
            still.length > 0
              ? `tests fail without mutants (baseline, exit 4): ${listSome(still)} does not parse even without instrumentation, so the source or the project's toolchain is at fault, not mutator (${transformErrorLine(retryStderr)}).\n${baselineFailure(retryStderr, options.root)}${adapterHint}`
              : `tests fail without mutants (baseline, exit 4): ${baselineFailure(retryStderr, options.root)}${adapterHint}\n${retried}`,
        });
      }

      if (retryFailed && retry.exitCode !== 0 && retry.exitCode !== EXIT_GATE_FAILED) {
        return result('error', {
          ...ran(retry, retryArgs, durationMs),
          detail: `mutator exited with ${retry.exitCode ?? `signal ${retry.signal}`}: ${errorExcerpt(withoutDebug(redact(retry.stderr)))}\n${retried}`,
        });
      }
      warnings.push(
        `${list} ${broken.length === 1 ? 'was' : 'were'} left out of mutation, so none of ${broken.length === 1 ? 'its' : 'their'} mutants ran: the project's bundler could not parse mutator's instrumented copy (${parseError}), while the tests load the file itself. This is usually a bug in the bundler's parser, and upgrading Vite (or rolldown and oxc) may fix it`,
      );
      excluded = broken;
      run = retry;
      args = retryArgs;
    }
  }
  const common = ran(run, args, durationMs);
  const { rawReportPath } = common;

  if (run.spawnError)
    return result('error', { ...common, detail: `could not start mutator: ${run.spawnError}` });

  if (run.timedOut) {
    return result('timeout', {
      ...common,
      detail: `mutator exceeded mutation.timeoutMs (${options.config.mutation.timeoutMs} ms) and was killed${
        options.testFiles === undefined
          ? ' (it ran every test the project config selects)'
          : ` (it ran ${options.testFiles.length} test file(s) that import the code in scope)`
      }`,
    });
  }

  if (options.signal?.aborted)
    return result('cancelled', { ...common, detail: 'aborted while mutator was running' });

  if (run.exitCode === EXIT_BASELINE_FAILED) {
    return result('failed', {
      ...common,
      detail: `tests fail without mutants (baseline, exit 4): ${baselineFailure(redact(run.stderr), options.root)}${adapterHint}`,
    });
  }

  if (run.exitCode !== 0 && run.exitCode !== EXIT_GATE_FAILED) {
    return result('error', {
      ...common,
      detail: `mutator exited with ${run.exitCode ?? `signal ${run.signal}`}: ${errorExcerpt(withoutDebug(redact(run.stderr)))}`,
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
