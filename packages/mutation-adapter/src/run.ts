import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  type Mutant,
  majorVersion,
  redact,
  redactDeep,
  resolveInsideRoot,
  resolvePackageVersion,
  runProjectTests,
  type TestRunnerProvider,
  type VeritasConfig,
  VeritasError,
} from '@under18dev/veritas-core';
import { detectMutator, PINNED_MUTATOR_VERSION, summarize } from './detect.js';
import {
  baselineFailure,
  errorExcerpt,
  instrumentationFailures,
  isRelativeGlob,
  listSome,
  mutatorProgress,
  selectedTestFileCount,
  timeBudgetExhausted,
  transformErrorLine,
  withoutDebug,
} from './diagnose.js';
import {
  importMutationReport,
  type NamedTest,
  type NamedTestFile,
  TestNameIndex,
  type WithheldReason,
} from './import.js';
import { countMutants, emptyCounts, type MutationRunResult, type MutationRunStatus } from './schema.js';

export interface RunMutationOptions {
  root: string;
  config: VeritasConfig;
  /** The provider of the project's test runner, which mutator runs the tests with. */
  testRunner: TestRunnerProvider;
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
   * The root is an isolated copy whose content may have been written by the code under test (`improve`). Then the
   * project's mutator is looked up inside the root only, not in its parents (a shared temporary directory), and
   * mutator's working directory `.mutator` is removed before each run: mutator adopts verdicts stored there (its
   * resume database) without running the tests, so a test could plant kills.
   */
  isolatedCopy?: boolean;
  /**
   * Test files (POSIX, relative to the root) that can kill these mutants. When given, mutator runs only
   * them, through a generated test runner config; an empty list means no test reaches the code in scope.
   */
  testFiles?: string[];
  /** Test runner config passed as `--config`. */
  configPath?: string;
  /**
   * Pass `--no-typecheck` (true) or not (false), whatever `mutation.typecheck` says. By default `--no-typecheck` is
   * passed when `mutation.typecheck` is `off`, or when the root tsconfig.json only references other projects.
   */
  noTypecheck?: boolean;
  /** Source files (relative to the root, no glob characters) passed as `--exclude`. */
  exclude?: string[];
  /** Run at most this many mutants per source line (`--mutants-per-line`); the rest stay `pending`. */
  mutantsPerLine?: number;
  /**
   * Seconds after which mutator starts no new mutant, when that is earlier than 75% of the timeout (the default), to
   * leave time for work after this run.
   */
  timeBudgetSeconds?: number;
  /**
   * The project's inventoried tests, to resolve the test names in mutator's report to their ids exactly, or for a
   * table-driven test (`each` in `modifiers`) by its title template. Without them, names are split with the runner's
   * full-name separator.
   */
  tests?: readonly NamedTest[];
  /** The inventoried test files, for those that may register tests static analysis did not see. */
  testFileInfo?: readonly NamedTestFile[];
}

const INEXACT_BECAUSE: Record<Extract<WithheldReason, { kind: 'inexact_file' }>['because'], string> = {
  dynamic_title: 'a test title that is not a literal',
  dynamic_suite: 'a describe title that is not a literal',
  registered_in_function: 'a test registered inside a function',
  open_collection:
    'code at the top level or in a describe callback that may register tests, such as a call of a shared suite',
  imported_registrations: 'a local module it imports registers tests',
  imported_open_module: 'a local module it imports runs code when loaded that may register tests',
};

/** One warning for each reason names in mutator's report were credited to no test (see `TestNameIndex`). */
function withheldWarnings(index: TestNameIndex): string[] {
  const groups = new Map<string, string[]>();

  for (const [name, reason] of index.withheld) {
    const what =
      reason.kind === 'templates'
        ? 'match the titles of more than one table-driven test (.each)'
        : reason.kind === 'exact_and_template'
          ? 'are the title of one test and also match the title of a table-driven test (.each)'
          : reason.kind === 'skipped_exact'
            ? 'are the title only of a test that is skipped or a todo, which cannot have run'
            : `fit the title of a test in a file where static analysis could not read the full name of every test (${INEXACT_BECAUSE[reason.because]}), so they may belong to a test whose name was not read`;
    const list = groups.get(what) ?? [];
    list.push(redact(summarize(name, 1, 200)));
    groups.set(what, list);
  }

  return [...groups].map(([what, names]) => {
    names.sort();

    return `${names.length} test name(s) in mutator's report ${what}; their kills and coverage are credited to no test: ${listSome(names)}`;
  });
}

const MUTANT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** The test runner mutator uses without `--runner`. */
const DEFAULT_MUTATOR_RUNNER = 'vitest';

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
export function buildMutatorArgs(
  options: Omit<RunMutationOptions, 'testRunner' | 'tests'> & { runner?: string; configFlag?: string },
): string[] {
  const args = ['--root', path.resolve(options.root), '--reporter', 'json', '--reporter', 'agent'];

  // mutator runs Vitest unless told otherwise; the flag is passed only for another runner.
  if (options.runner !== undefined && options.runner !== DEFAULT_MUTATOR_RUNNER)
    args.push('--runner', options.runner);
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

  if (options.configPath !== undefined) args.push(options.configFlag ?? '--config', options.configPath);

  if (options.noTypecheck) args.push('--no-typecheck');

  if (options.killMatrix) args.push('--kill-matrix');

  if (options.mutantsPerLine !== undefined) {
    if (!Number.isInteger(options.mutantsPerLine) || options.mutantsPerLine < 1)
      throw new TypeError(`invalid --mutants-per-line: ${options.mutantsPerLine}`);
    args.push('--mutants-per-line', String(options.mutantsPerLine));
  }

  for (const key of options.only ?? []) {
    if (!MUTANT_KEY.test(key)) throw new TypeError(`invalid mutant key for --only: ${JSON.stringify(key)}`);
    args.push('--only', key);
  }
  const budget = timeBudgetSeconds(options.config.mutation.timeoutMs);
  args.push(
    '--time-budget',
    String(
      options.timeBudgetSeconds === undefined
        ? budget
        : Math.max(1, Math.min(budget, Math.floor(options.timeBudgetSeconds))),
    ),
  );

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
 * What to add to the detail of a timed-out run, from what mutator printed: when the baseline finished but no mutant
 * had finished, `--time-budget` (which only stops new mutants from starting) did not help. When mutator had not yet
 * printed its plan of mutants to run, the time most likely went to type-checking them, unless that was off.
 */
function timeoutHint(run: { stderr: string; stderrTail?: string }, noTypecheck: boolean): string {
  const progress = mutatorProgress(`${run.stderr}\n${run.stderrTail ?? ''}`);

  if (!progress.pastBaseline || progress.baselineFailed || progress.mutantFinished) return '';

  const before =
    '. mutator finished the baseline ("dry run finished") but no mutant had finished when it was killed; its --time-budget only stops new mutants from starting, so it did not end the run in time';

  if (!noTypecheck && !progress.mutantsPlanned)
    return `${before}. mutator had not printed its plan of mutants to run, so it most likely spent the time type-checking the mutants. Set mutation.typecheck to "off" to skip that, or narrow the run with --since <ref>`;

  return `${before}. Narrow the run with --since <ref>, or raise mutation.timeoutMs`;
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
  const typecheckOff = options.noTypecheck === undefined && options.config.mutation.typecheck === 'off';
  const noTypecheck = options.noTypecheck ?? (typecheckOff || rootTsconfigHasNoFiles(options.root));

  if (typecheckOff)
    warnings.push(
      'mutation.typecheck is "off": mutants were not type-checked, so mutants the compiler would reject were run and counted too. Some of them are killed only because the mutated code breaks at run time, which makes the counts read more favourably than a type-checked run would',
    );
  else if (noTypecheck && options.noTypecheck === undefined)
    warnings.push(
      'tsconfig.json at the root only references other projects, and mutator type-checks against that file alone: mutants were not type-checked, so some survivors may be type errors',
    );

  const runner = options.testRunner;
  const { minMajor, declaredMajor, mutatorRunner, configFlag, experimental } = runner.mutation;

  if (mutatorRunner === null)
    return result('unsupported', { detail: `@mizchi/mutator cannot run ${runner.displayName} tests` });
  const unsupported = runner.mutation.unsupportedReason(options.root);

  if (unsupported !== null) return result('unsupported', { detail: unsupported });

  if (experimental !== null)
    warnings.push(`mutation testing with ${runner.displayName} is experimental: ${experimental}`);
  const runnerVersion = resolvePackageVersion(options.root, runner.detection.packageName);
  const major = majorVersion(runnerVersion);

  if (major !== null && minMajor !== null && major < minMajor)
    return result('unsupported', {
      detail: `mutation testing needs ${runner.displayName} ${minMajor} or later; the project has ${runner.displayName} ${runnerVersion}`,
    });

  if (major !== null && declaredMajor !== null && major < declaredMajor)
    warnings.push(
      `@mizchi/mutator declares ${runner.displayName} ${declaredMajor}; the project has ${runner.displayName} ${runnerVersion}, which has worked but is outside that range`,
    );

  if (options.testFiles?.length === 0) {
    warnings.push('no test imports the code in scope; mutation was not run');

    return result('succeeded', { detail: 'no test can kill these mutants' });
  }
  let args: string[];

  try {
    args = buildMutatorArgs({ ...options, reportDir, noTypecheck, runner: mutatorRunner, configFlag });
  } catch (error) {
    return result('error', { detail: (error as Error).message });
  }

  if (options.signal?.aborted) return result('cancelled', { detail: 'aborted before mutator started' });

  const detection = await detectMutator(options.root, {
    ...(options.mutatorBin === undefined ? {} : { binPath: options.mutatorBin }),
    fallbackToAdapter: !options.projectMutatorOnly,
    ...(options.isolatedCopy ? { stopAt: options.root } : {}),
  });
  const backend = { name: 'mizchi' as const, version: detection.version };

  if (!detection.available || detection.binPath === null) {
    return result('unsupported', { backend, detail: detection.detail });
  }

  // The adapter's copy runs the project's test runner, but the runner loads mutator's setup file from where Veritas
  // is installed, outside the project; that is allowed below, and anything else loaded from there may still fail.
  const ownCopyHint = `the project has no @mizchi/mutator, so the copy bundled with Veritas ran the project's ${runner.displayName} with files from outside the project; if the first error names such a file, add @mizchi/mutator to the project's devDependencies`;
  const allowDirs =
    detection.origin === 'adapter' ? runner.mutation.bundledMutatorDirs(detection.binPath) : [];
  const writesConfig = options.testFiles !== undefined || allowDirs.length > 0;

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
    (options.exclude?.length ?? 0) > 0 && '--exclude',
    options.killMatrix && '--kill-matrix',
    options.mutantsPerLine !== undefined && '--mutants-per-line',
    (options.only?.length ?? 0) > 0 && '--only',
    writesConfig && configFlag,
    mutatorRunner !== DEFAULT_MUTATOR_RUNNER && '--runner',
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
    configPath = runner.mutation.writeConfig({
      root: options.root,
      dir: reportDir,
      ...(options.testFiles === undefined ? {} : { testFiles: options.testFiles }),
      allowDirs,
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
      runner: mutatorRunner,
      configFlag,
      ...(configPath === undefined ? {} : { configPath }),
      // The caller's own exclusions stay, and the files diagnosed here are added to them.
      ...(exclude.length > 0 ? { exclude: [...new Set([...(options.exclude ?? []), ...exclude])] } : {}),
    });
  const reportPath = path.join(reportDir, 'mutation.json');
  const spawn = (argv: string[], timeoutMs = options.config.mutation.timeoutMs) => {
    if (options.isolatedCopy) rmSync(path.join(options.root, '.mutator'), { recursive: true, force: true });

    return runProjectTests(process.execPath, [binPath, ...argv], {
      cwd: options.root,
      timeoutMs,
      memoryMb: options.config.limits.memoryMb,
      // mutator logs why a test file failed to load only to this debug channel, and only when one does.
      env: { NODE_DEBUG: 'mutator' },
      // A mutation run takes minutes; its progress lines show that it is working.
      logOutput: true,
      label: 'mutator',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
  const ran = (run: Awaited<ReturnType<typeof spawn>>, argv: string[], durationMs: number) => ({
    backend,
    command: [process.execPath, binPath, ...argv],
    exitCode: run.exitCode,
    durationMs,
    rawReportPath: existsSync(reportPath) ? reportPath : null,
    typecheck: noTypecheck ? ('off' as const) : ('auto' as const),
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
      }${timeoutHint(run, noTypecheck)}`,
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
  const testIds =
    options.tests === undefined
      ? undefined
      : new TestNameIndex(
          options.tests,
          runner.fullNameSeparator,
          options.testFileInfo,
          runner.mutation.titleKeys,
        );

  try {
    const json: unknown = JSON.parse(readFileSync(rawReportPath, 'utf8'));
    mutants = importMutationReport(json, {
      root: options.root,
      source: 'mutator',
      childProcessKeys,
      fullNameSeparator: runner.fullNameSeparator,
      projectPrefix: runner.mutation.projectPrefix,
      ...(testIds === undefined ? {} : { testIds }),
    });
  } catch (error) {
    return result('error', {
      ...common,
      agentReport,
      detail: `could not parse ${rawReportPath}: ${redact((error as Error).message)}`,
    });
  }

  // A run without tests leaves every mutant "not covered", which reads as a result; it is a failure of the setup.
  const found = selectedTestFileCount(`${run.stderr}\n${run.stderrTail ?? ''}`);
  const selected = options.testFiles;
  const selectedList = selected
    ? ` of the ${selected.length} that import the code in scope (${listSome(selected)})`
    : '';
  const lookAt = `Check that the include and exclude patterns of the ${runner.displayName} config, and of its projects, match the test files`;
  let testRunUnverified = false;

  if (found === 0) {
    return result('failed', {
      ...common,
      agentReport,
      detail: `no test ran: the project's ${runner.displayName} config selected no test file${selectedList}, so every mutant would have been reported as not covered. ${lookAt}`,
    });
  }

  if (found === null) {
    // This mutator does not say how many test files ran (another version than the pinned one may word it
    // differently). With no test reaching any mutant either, nothing shows that a test ran: fail closed.
    const reached = mutants.some((m) => m.killedBy.length > 0 || m.coveredBy.length > 0);

    if (!reached && mutants.length > 0 && mutants.every((m) => m.status === 'no_coverage')) {
      return result('failed', {
        ...common,
        agentReport,
        detail: `no test is known to have run: mutator did not print how many test files the project's ${runner.displayName} config selected${selectedList}, and no test reached any mutant, so every mutant would have been reported as not covered. ${lookAt}`,
      });
    }
    testRunUnverified = true;
    warnings.push(
      `mutator did not print how many test files the project's ${runner.displayName} config selected, so Veritas could not check that the selected tests ran; mutation results are partial`,
    );
  } else if (selected && found < selected.length)
    warnings.push(
      `${selected.length - found} of the ${selected.length} test file(s) that import the code in scope did not run, because the project's ${runner.displayName} config does not select them (its include or exclude patterns); mutants only they could kill are reported as not covered`,
    );

  if (options.killMatrix && agent?.killMatrix === undefined) {
    warnings.push('--kill-matrix was requested but the agent report has no killMatrix');
  }

  if (testIds !== undefined) warnings.push(...withheldWarnings(testIds));
  const counts = countMutants(mutants);
  // On a very long run the head of stderr can fill up before mutator's last lines; its tail keeps them.
  const budget = timeBudgetExhausted(run.stderr) ?? timeBudgetExhausted(run.stderrTail ?? '');

  if (budget !== null) {
    warnings.push(
      `mutator's time budget of ${budget.seconds}s ran out (${options.timeBudgetSeconds === undefined ? '75% of mutation.timeoutMs' : 'set below 75% of mutation.timeoutMs to leave time for the work after this run'}, or of what was left of it when mutator ran a second time): ${budget.notRun} mutant(s) were not run, so the results cover only part of the code in scope and mutation results are partial. Narrow the run with --since <ref>, or raise mutation.timeoutMs`,
    );
  } else if (counts.pending > 0) {
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
    ...(budget === null ? {} : { timeBudgetExhausted: budget }),
    ...(testRunUnverified ? { testRunUnverified: true as const } : {}),
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
